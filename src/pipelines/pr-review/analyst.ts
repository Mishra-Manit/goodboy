/**
 * pr_analyst stage. Reads the PR, fans out subagents via pi-subagents,
 * commits auto-fixable issues back to the PR branch, posts a summary comment.
 *
 * Primary context is pr-impact.md (curated by the impact stage). If that file
 * is missing, the full memory block is prepended as a fallback -- never both.
 * Throws on hard failure so the pipeline maps it to `failTask`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { prAnalystSystemPrompt, prAnalystInitialPrompt } from "./analyst-prompts.js";

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
}

/** Throws on failure -- pipeline catches and fails the task. */
export async function runPrAnalyst(opts: PrAnalystOptions): Promise<void> {
  const { taskId, repo, nwo, prNumber, headRef, artifactsDir, worktreePath, sendTelegram, chatId } = opts;
  const env = loadEnv();
  const cap = subagentCapability();

  // Prefer pr-impact.md. Fall back to the full memory block only if the
  // impact stage failed to produce one. `memoryBlock` already wraps itself
  // in a "CODEBASE MEMORY:" header so the analyst can recognize the prefix.
  const impactExists = existsSync(path.join(artifactsDir, "pr-impact.md"));
  if (!impactExists) {
    log.warn(`pr-impact.md missing for ${taskId}; analyst running with full memory fallback`);
  }
  const fallback = impactExists ? "" : await memoryBlock(repo);
  const systemPrompt = (fallback.trim() ? `${fallback}\n\n` : "")
    + prAnalystSystemPrompt({ repo, nwo, headRef, prNumber, artifactsDir, worktreePath });

  await runStage({
    taskId,
    stage: "pr_analyst",
    cwd: worktreePath,
    systemPrompt,
    initialPrompt: prAnalystInitialPrompt(artifactsDir),
    model: env.PI_MODEL_PR_ANALYST ?? env.PI_MODEL,
    sendTelegram,
    chatId,
    stageLabel: "PR Analyst",
    timeoutMs: ANALYST_TIMEOUT_MS,
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
  });

  log.info(`pr_analyst complete for task ${taskId} (${nwo}#${prNumber})`);
}
