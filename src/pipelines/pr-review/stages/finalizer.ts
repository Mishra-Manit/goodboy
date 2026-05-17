/**
 * pr_finalizer stage. Reads analyst artifacts, optionally captures visual assets,
 * posts the public PR comment, and writes the dashboard review model.
 */

import { readFile, stat } from "node:fs/promises";
import { createLogger } from "../../../shared/runtime/logger.js";
import { resolveModel } from "../../../shared/runtime/config.js";
import { runStage, type SendTelegram, type StageValidation } from "../../../core/stage.js";
import { stageSubagentAssets, subagentCapability } from "../../../core/subagents/index.js";
import { prFinalizerSystemPrompt, prFinalizerInitialPrompt } from "../prompts/finalizer.js";
import { prReviewOutputs } from "../output-contracts.js";
import { prReviewArtifactSchema } from "../../../shared/contracts/pr-review.js";
import {
  ensureReviewAssetsDir,
  PR_VISUAL_MANIFEST_FILENAME,
  PR_VISUAL_SUMMARY_FILENAME,
  publicReviewAssetUrl,
  reviewAssetPath,
} from "../assets.js";

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
    taskKind: "pr_review",
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
    postValidate: () => validateVisualCaptureArtifacts(taskId, artifactsDir, visualUrl),
  });

  if (!result.ok) throw new Error(`pr_finalizer validation failed: ${result.reason}`);
  log.info(`pr_finalizer complete for task ${taskId} (${nwo}#${prNumber})`);
}

async function validateVisualCaptureArtifacts(
  taskId: string,
  artifactsDir: string,
  visualUrl: string,
): Promise<StageValidation> {
  const reviewPath = prReviewOutputs.review.resolve(artifactsDir, undefined).path;
  const finalCommentPath = prReviewOutputs.finalComment.resolve(artifactsDir, undefined).path;
  const parsed = prReviewArtifactSchema.safeParse(JSON.parse(await readFile(reviewPath, "utf8")));
  if (!parsed.success) return { valid: false, reason: parsed.error.message };
  if (parsed.data.visualSnapshot.type !== "captured") return { valid: true };

  const imagePath = reviewAssetPath(taskId, PR_VISUAL_SUMMARY_FILENAME);
  const manifestPath = reviewAssetPath(taskId, PR_VISUAL_MANIFEST_FILENAME);
  if (!imagePath || !manifestPath) return { valid: false, reason: "invalid visual asset path" };

  const image = await stat(imagePath).catch(() => null);
  if (!image?.isFile() || image.size === 0) return { valid: false, reason: "captured visual snapshot image is missing or empty" };

  const manifest = await stat(manifestPath).catch(() => null);
  if (!manifest?.isFile() || manifest.size === 0) return { valid: false, reason: "captured visual manifest is missing or empty" };
  try {
    JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return { valid: false, reason: "captured visual manifest is not valid JSON" };
  }

  const finalComment = await readFile(finalCommentPath, "utf8");
  if (!finalComment.includes(visualUrl)) return { valid: false, reason: "captured visual URL is missing from final-comment.md" };
  return { valid: true };
}
