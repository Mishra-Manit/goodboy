/**
 * pr_analyst stage. The heavy lifter: reads the PR, fans out subagents via
 * pi-subagents, aggregates reports, commits auto-fixable issues back to the
 * PR branch, and posts a single summary comment.
 *
 * Primary context is pr-impact.md. Falls back to the full memory block only
 * if the impact stage failed and left no file behind. Never both.
 * Throws on hard failure so the pipeline can map it to `failTask`.
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
// posts a comment. Well above the default 30-minute stage timeout.
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

/** Run the pr_analyst stage. Throws on failure -- pipeline catches and fails the task. */
export async function runPrAnalyst(opts: PrAnalystOptions): Promise<void> {
  const { taskId, repo, nwo, prNumber, headRef, artifactsDir, worktreePath, sendTelegram, chatId } = opts;

  const cap = subagentCapability();
  const systemPrompt = await buildSystemPrompt(opts);

  await runStage({
    taskId,
    stage: "pr_analyst",
    cwd: worktreePath,
    systemPrompt,
    initialPrompt: prAnalystInitialPrompt(artifactsDir),
    model: modelForAnalyst(),
    sendTelegram,
    chatId,
    stageLabel: "PR Analyst",
    timeoutMs: ANALYST_TIMEOUT_MS,
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
  });

  log.info(`pr_analyst complete for task ${taskId} (${nwo}#${prNumber})`);
}

/**
 * Assemble the analyst's system prompt. If pr-impact.md is present, the
 * impact curation succeeded and is the sole context. Otherwise, prepend the
 * full memory block as a degraded fallback so the analyst still has codebase
 * knowledge to work from.
 */
async function buildSystemPrompt(opts: PrAnalystOptions): Promise<string> {
  const { repo, nwo, headRef, prNumber, artifactsDir, worktreePath } = opts;

  const impactExists = existsSync(path.join(artifactsDir, "pr-impact.md"));
  const fallbackMemory = impactExists ? "" : await memoryBlock(repo);
  if (!impactExists) {
    log.warn(`pr-impact.md missing for ${opts.taskId}; analyst running with full memory fallback`);
  }

  const prefix = fallbackMemory.trim().length > 0 ? `${fallbackMemory}\n\n` : "";
  return prefix + prAnalystSystemPrompt({ repo, nwo, headRef, prNumber, artifactsDir, worktreePath });
}

function modelForAnalyst(): string {
  const env = loadEnv();
  return env.PI_MODEL_PR_ANALYST ?? env.PI_MODEL;
}
