/**
 * pr_finalizer stage. Reads analyst artifacts, optionally captures visual assets,
 * posts the public PR comment, and writes the dashboard review model.
 */

import { createLogger } from "../../../shared/runtime/logger.js";
import { resolveModel } from "../../../shared/runtime/config.js";
import { runStage, type SendTelegram } from "../../../core/stage.js";
import { stageSubagentAssets, subagentCapability } from "../../../core/subagents/index.js";
import { prFinalizerSystemPrompt, prFinalizerInitialPrompt } from "../prompts/finalizer.js";
import { prReviewOutputs } from "../output-contracts.js";
import { ensureReviewAssetsDir, PR_VISUAL_SUMMARY_FILENAME, publicReviewAssetUrl } from "../assets.js";

const log = createLogger("pr-finalizer");

const FINALIZER_TIMEOUT_MS = 25 * 60 * 1000;

export interface PrFinalizerOptions {
  taskId: string;
  repo: string;
  nwo: string;
  prNumber: number;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  availableImpactVariants: number[];
}

// --- Public API ---

/** Run required final presentation and GitHub comment publishing. */
export async function runPrFinalizer(opts: PrFinalizerOptions): Promise<void> {
  const {
    taskId,
    repo,
    nwo,
    prNumber,
    artifactsDir,
    worktreePath,
    sendTelegram,
    chatId,
    availableImpactVariants,
  } = opts;

  await stageSubagentAssets(worktreePath);
  const cap = subagentCapability();
  const assetsDir = await ensureReviewAssetsDir(taskId);
  const visualUrl = publicReviewAssetUrl(taskId, PR_VISUAL_SUMMARY_FILENAME);
  const outputs = [
    prReviewOutputs.review.resolve(artifactsDir, undefined),
    prReviewOutputs.finalComment.resolve(artifactsDir, undefined),
  ];

  const result = await runStage({
    taskId,
    stage: "pr_finalizer",
      cwd: worktreePath,
    systemPrompt: prFinalizerSystemPrompt({
      taskId,
      repo,
      nwo,
      prNumber,
      artifactsDir,
      worktreePath,
      assetsDir,
      visualUrl,
      availableImpactVariants,
    }),
    initialPrompt: prFinalizerInitialPrompt(artifactsDir, availableImpactVariants),
      model: resolveModel("PI_MODEL_PR_FINALIZER"),
      sendTelegram,
      chatId,
    stageLabel: "PR Finalizer",
    timeoutMs: FINALIZER_TIMEOUT_MS,
    outputs,
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
  });

  if (!result.ok) throw new Error(`pr_finalizer validation failed: ${result.reason}`);
  log.info(`pr_finalizer complete for task ${taskId} (${nwo}#${prNumber})`);
}
