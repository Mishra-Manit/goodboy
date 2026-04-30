/**
 * pr_impact fanout. Runs independent impact curators over deterministic diff
 * variants. Partial failure is allowed: the analyst consumes successful reports
 * or falls back to full memory if every variant fails.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { resolveModel } from "../../shared/config.js";
import { TaskCancelledError, isTaskCancelled, runStage, type SendTelegram } from "../../core/stage.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";
import { toErrorMessage } from "../../shared/errors.js";
import { artifactPath, hasNonEmptyArtifact } from "../../shared/artifacts.js";
import { PR_IMPACT_VARIANT_COUNT, prImpactVariantFiles } from "./artifacts.js";

const log = createLogger("pr-impact");

const IMPACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  /** Variant stages intentionally run silently to avoid three Telegram pings. */
  memoryBody: string;
}

export interface ImpactFanoutResult {
  available: number[];
  ok: boolean;
}

/** Run every configured impact variant concurrently; never throws for variant failures. */
export async function runImpactAnalyzers(opts: ImpactAnalyzerOptions): Promise<ImpactFanoutResult> {
  const settled = await Promise.allSettled(
    Array.from({ length: PR_IMPACT_VARIANT_COUNT }, (_, index) => runImpactVariant(opts, index + 1)),
  );
  if (isTaskCancelled(opts.taskId)) throw new TaskCancelledError(opts.taskId);

  const available = settled.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [result.value] : []
  ));

  if (available.length === 0) {
    log.warn(`All pr_impact variants failed for ${opts.taskId}; analyst falls back to full memory block`);
  }

  return { available, ok: available.length > 0 };
}

async function runImpactVariant(opts: ImpactAnalyzerOptions, variant: number): Promise<number | null> {
  const { taskId, repo, artifactsDir, worktreePath, sendTelegram, memoryBody } = opts;
  const files = prImpactVariantFiles(variant);

  try {
    const result = await runStage({
      taskId,
      stage: "pr_impact",
      variant,
      cwd: worktreePath,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, worktreePath, memoryBody, variant),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir, variant),
      model: resolveModel("PI_MODEL_PR_IMPACT"),
      sendTelegram,
      chatId: null,
      stageLabel: `PR Impact Curation v${variant}`,
      timeoutMs: IMPACT_TIMEOUT_MS,
      postValidate: async () => validateImpactArtifact(artifactsDir, files.impact),
    });

    return result.ok ? variant : null;
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    log.warn(`pr_impact v${variant} failed for ${taskId}: ${toErrorMessage(err)}`);
    return null;
  }
}

async function validateImpactArtifact(
  artifactsDir: string,
  filename: string,
): Promise<{ valid: boolean; reason?: string }> {
  const exists = await hasNonEmptyArtifact(artifactsDir, filename);
  if (!exists) return { valid: false, reason: `Impact analyzer failed to write ${filename}` };

  const content = await readFile(artifactPath(artifactsDir, filename), "utf8").catch(() => "");
  return content.includes("IMPACT_ANALYSIS_DONE")
    ? { valid: true }
    : { valid: false, reason: `${filename} did not include IMPACT_ANALYSIS_DONE` };
}
