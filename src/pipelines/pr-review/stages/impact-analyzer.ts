/**
 * pr_impact fanout. Runs independent impact curators over deterministic diff
 * variants. Partial failure is allowed: the analyst consumes successful reports
 * or falls back to full memory if every variant fails.
 */

import { createLogger } from "../../../shared/runtime/logger.js";
import { resolveModel } from "../../../shared/runtime/config.js";
import { TaskCancelledError, isTaskCancelled, runStage, type SendTelegram } from "../../../core/stage.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "../prompts/impact.js";
import { toErrorMessage } from "../../../shared/runtime/errors.js";
import { PR_IMPACT_VARIANT_COUNT, prReviewOutputs } from "../output-contracts.js";

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
  reviewerFeedback: string;
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
  const { taskId, repo, artifactsDir, worktreePath, sendTelegram, memoryBody, reviewerFeedback } = opts;
  const output = prReviewOutputs.impact.resolve(artifactsDir, { variant });

  try {
    const result = await runStage({
      taskId,
      taskKind: "pr_review",
      stage: "pr_impact",
      variant,
      cwd: worktreePath,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, worktreePath, memoryBody, reviewerFeedback, variant),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir, variant),
      model: resolveModel("PI_MODEL_PR_IMPACT"),
      sendTelegram,
      chatId: null,
      stageLabel: `PR Impact Curation v${variant}`,
      timeoutMs: IMPACT_TIMEOUT_MS,
      outputs: [output],
    });

    return result.ok ? variant : null;
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    log.warn(`pr_impact v${variant} failed for ${taskId}: ${toErrorMessage(err)}`);
    return null;
  }
}
