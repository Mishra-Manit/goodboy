/**
 * pr_analyst stage. Reads the PR, fans out subagents via pi-subagents,
 * commits auto-fixable issues back to the PR branch, posts a summary comment.
 *
 * Primary context is the successful pr-impact.vN.md set. If every impact
 * variant fails, the full memory block is prepended as a fallback -- never both.
 * Throws on hard failure so the pipeline maps it to `failTask`.
 */

import { createLogger } from "../../../shared/runtime/logger.js";
import { resolveModel } from "../../../shared/runtime/config.js";
import { runStage, type SendTelegram } from "../../../core/stage.js";
import { stageSubagentAssets, subagentCapability } from "../../../core/subagents/index.js";
import { prAnalystSystemPrompt, prAnalystInitialPrompt } from "../prompts/analyst.js";
import { validatePrAnalystOutputs } from "../analyst-validation.js";

const log = createLogger("pr-analyst");

// Generous budget: the analyst plans, fans out subagents, applies fixes, and
// posts a comment -- well above the default 30-minute stage timeout.
const ANALYST_TIMEOUT_MS = 45 * 60 * 1000;

export interface PrAnalystOptions {
  taskId: string;
  repo: string;
  nwo: string;
  prNumber: number;
  headRef: string;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  availableImpactVariants: number[];
  fallbackMemory: string;
  reviewerFeedback: string;
}

/** Throws on failure -- pipeline catches and fails the task. */
export async function runPrAnalyst(opts: PrAnalystOptions): Promise<void> {
  const {
    taskId,
    repo,
    nwo,
    prNumber,
    headRef,
    artifactsDir,
    worktreePath,
    sendTelegram,
    chatId,
    availableImpactVariants,
    fallbackMemory,
    reviewerFeedback,
  } = opts;
  await stageSubagentAssets(worktreePath);
  const cap = subagentCapability();

  if (availableImpactVariants.length === 0) {
    log.warn(`No pr_impact variants available for ${taskId}; analyst running with full memory fallback`);
  }

  const feedbackPrefix = reviewerFeedback.trim() ? `${reviewerFeedback}\n\n` : "";
  const memoryPrefix = availableImpactVariants.length > 0 || !fallbackMemory.trim() ? "" : `${fallbackMemory}\n\n`;
  const systemPrompt = feedbackPrefix + memoryPrefix + prAnalystSystemPrompt({
      repo,
      nwo,
      headRef,
      prNumber,
      artifactsDir,
      worktreePath,
      availableImpactVariants,
    });

  const result = await runStage({
    taskId,
    stage: "pr_analyst",
    cwd: worktreePath,
    systemPrompt,
    initialPrompt: prAnalystInitialPrompt(artifactsDir, availableImpactVariants),
    model: resolveModel("PI_MODEL_PR_ANALYST"),
    sendTelegram,
    chatId,
    stageLabel: "PR Analyst",
    timeoutMs: ANALYST_TIMEOUT_MS,
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
    postValidate: async () => validatePrAnalystOutputs(artifactsDir),
  });

  if (!result.ok) {
    throw new Error(`pr_analyst validation failed: ${result.reason}`);
  }

  log.info(`pr_analyst complete for task ${taskId} (${nwo}#${prNumber})`);
}
