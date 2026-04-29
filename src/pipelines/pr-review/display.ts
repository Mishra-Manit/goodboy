/**
 * pr_display stage. Reads every prior artifact and the worktree, then writes
 * review.json -- the dashboard model. Soft-fails so the PR review can still
 * complete with the GitHub summary comment when display generation fails.
 */

import { createLogger } from "../../shared/logger.js";
import { resolveModel } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { prDisplaySystemPrompt, prDisplayInitialPrompt } from "./display-prompts.js";
import { readReviewArtifact } from "./read-review.js";
import { prReviewArtifactPaths } from "./artifacts.js";

const log = createLogger("pr-display");

const DISPLAY_TIMEOUT_MS = 15 * 60 * 1000;

export interface PrDisplayOptions {
  taskId: string;
  repo: string;
  nwo: string;
  prNumber: number;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

// --- Public API ---

/** Soft-fail -- never throws. Caller continues regardless of outcome. */
export async function runPrDisplay(opts: PrDisplayOptions): Promise<void> {
  const { taskId, repo, nwo, prNumber, artifactsDir, worktreePath, sendTelegram, chatId } = opts;

  try {
    const result = await runStage({
      taskId,
      stage: "pr_display",
      cwd: worktreePath,
      systemPrompt: prDisplaySystemPrompt({ repo, nwo, prNumber, artifactsDir, worktreePath }),
      initialPrompt: prDisplayInitialPrompt(artifactsDir),
      model: resolveModel("PI_MODEL_PR_DISPLAY"),
      sendTelegram,
      chatId,
      stageLabel: "PR Display",
      timeoutMs: DISPLAY_TIMEOUT_MS,
      postValidate: async () => {
        const paths = prReviewArtifactPaths(artifactsDir);
        const artifact = await readReviewArtifact(paths.review);
        return artifact
          ? { valid: true }
          : { valid: false, reason: "review.json missing or failed schema validation" };
      },
    });

    if (result.ok) {
      log.info(`pr_display complete for task ${taskId} (${nwo}#${prNumber})`);
    } else {
      log.warn(`pr_display validation failed for task ${taskId}: ${result.reason}`);
    }
  } catch (err) {
    log.error(`pr_display failed for task ${taskId}; continuing without artifact`, err);
  }
}
