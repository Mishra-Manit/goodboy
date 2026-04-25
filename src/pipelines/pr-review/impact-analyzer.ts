/**
 * pr_impact stage. Context curator: runs inside the PR worktree with full
 * read access, cross-references memory against live code, and writes
 * pr-impact.md -- the curated context the analyst consumes instead of the
 * full memory block. Soft-fails: on error, the file is absent and the
 * analyst falls back to the full memory block.
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { impactAnalyzerSystemPrompt, impactAnalyzerInitialPrompt } from "./impact-prompts.js";

const log = createLogger("pr-impact");

const IMPACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImpactAnalyzerOptions {
  taskId: string;
  repo: string;
  artifactsDir: string;
  worktreePath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/** Run the pr_impact stage. Never throws: failure leaves pr-impact.md absent. */
export async function runImpactAnalyzer(opts: ImpactAnalyzerOptions): Promise<void> {
  const { taskId, repo, artifactsDir, worktreePath, sendTelegram, chatId } = opts;
  try {
    const memoryBody = await memoryBlock(repo);
    await runStage({
      taskId,
      stage: "pr_impact",
      cwd: worktreePath,
      systemPrompt: impactAnalyzerSystemPrompt(repo, artifactsDir, worktreePath, memoryBody),
      initialPrompt: impactAnalyzerInitialPrompt(artifactsDir),
      model: modelForImpact(),
      sendTelegram,
      chatId,
      stageLabel: "PR Impact Curation",
      timeoutMs: IMPACT_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`pr_impact failed for ${taskId}: ${message} -- analyst falls back to full memory block`);
  }
}

function modelForImpact(): string {
  const env = loadEnv();
  return env.PI_MODEL_PR_IMPACT ?? env.PI_MODEL;
}
