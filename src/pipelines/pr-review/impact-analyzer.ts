/**
 * pr_impact stage. Context curator: runs inside the PR worktree with full
 * read access, cross-references memory against live code, and writes
 * pr-impact.md -- the curated context the analyst consumes instead of the
 * full memory block. Soft-fails: on error, the file is absent and the
 * analyst falls back to the full memory block.
 */

import { createLogger } from "../../shared/logger.js";
import { resolveModel } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";
import { toErrorMessage } from "../../shared/errors.js";
import { hasNonEmptyArtifact } from "../../shared/artifacts.js";
import { PR_REVIEW_FILES } from "./artifacts.js";

const log = createLogger("pr-impact");

const IMPACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  memoryBody: string;
}

/** Never throws: failure leaves pr-impact.md absent and the analyst degrades. */
export async function runImpactAnalyzer(opts: ImpactAnalyzerOptions): Promise<boolean> {
  const { taskId, repo, artifactsDir, worktreePath, sendTelegram, chatId, memoryBody } = opts;
  try {
    const result = await runStage({
      taskId,
      stage: "pr_impact",
      cwd: worktreePath,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, worktreePath, memoryBody),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir),
      model: resolveModel("PI_MODEL_PR_IMPACT"),
      sendTelegram,
      chatId,
      stageLabel: "PR Impact Curation",
      timeoutMs: IMPACT_TIMEOUT_MS,
      postValidate: async () => {
        const ok = await hasNonEmptyArtifact(artifactsDir, PR_REVIEW_FILES.impact);
        return ok ? { valid: true } : { valid: false, reason: "Impact analyzer failed to write pr-impact.md" };
      },
    });

    return result.ok;
  } catch (err) {
    const msg = toErrorMessage(err);
    log.warn(`pr_impact failed for ${taskId}: ${msg} -- analyst falls back to full memory block`);
    return false;
  }
}
