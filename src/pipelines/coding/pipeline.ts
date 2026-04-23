/**
 * Coding task pipeline: sync repo -> worktree -> planner -> implementer ->
 * reviewer -> hand off to a PR session. Marks the task complete before
 * handoff; the PR session owns its own lifecycle from that point on.
 */

import path from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { emit } from "../../shared/events.js";
import { getRepo } from "../../shared/repos.js";
import { createWorktree, generateBranchName, syncRepo } from "../../core/git/worktree.js";
import * as queries from "../../db/repository.js";
import type { Env } from "../../shared/config.js";
import {
  failTask,
  notifyTelegram,
  clearActiveSession,
  runStage,
  type SendTelegram,
} from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import {
  codingPrompts,
  type CodingStage,
  type WorktreeEnv,
} from "./prompts.js";
import { startPrSession } from "../pr-session/session.js";
import { runMemory } from "../memory/pipeline.js";

const log = createLogger("coding");

interface StageSpec {
  readonly label: string;
  readonly modelKey: keyof Env;
  readonly artifact: string;
  readonly artifactError: string;
}

const STAGES: Record<CodingStage, StageSpec> = {
  planner: {
    label: "Planner",
    modelKey: "PI_MODEL_PLANNER",
    artifact: "plan.md",
    artifactError: "Planner failed to write plan.md",
  },
  implementer: {
    label: "Implementer",
    modelKey: "PI_MODEL_IMPLEMENTER",
    artifact: "implementation-summary.md",
    artifactError: "Implementer failed to write implementation-summary.md",
  },
  reviewer: {
    label: "Reviewer",
    modelKey: "PI_MODEL_REVIEWER",
    artifact: "review.md",
    artifactError: "Reviewer failed to write review.md",
  },
};

const STAGE_ORDER: readonly CodingStage[] = ["planner", "implementer", "reviewer"];

// --- Entry point ---

/** Run the full coding pipeline for a task. Errors surface via `failTask`; never throws. */
export async function runPipeline(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  return withPipelineSpan(
    { taskId, kind: "coding_task", repo: task.repo },
    () => runCodingPipelineInner(taskId, task, sendTelegram),
  );
}

async function runCodingPipelineInner(
  taskId: string,
  task: NonNullable<Awaited<ReturnType<typeof queries.getTask>>>,
  sendTelegram: SendTelegram,
): Promise<void> {
  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, task.telegramChatId);
    return;
  }

  const chatId = task.telegramChatId;
  await notifyTelegram(sendTelegram, chatId,
    `Task ${task.id.slice(0, 8)} started for repo ${task.repo}.\n\n${task.description}`);

  // Clean artifacts so retries start fresh.
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, chatId);
    return;
  }

  // Run the memory stage before planning. Soft-fail: never throws to caller.
  await runMemory({
    taskId,
    repo: task.repo,
    repoPath: repo.localPath,
    source: "task",
    sendTelegram,
    chatId,
  });

  const branch = await generateBranchName(taskId, task.description);
  let worktreePath: string;
  let agentsSuggestion: string | undefined;
  try {
    const worktree = await createWorktree(repo.localPath, branch, taskId);
    worktreePath = worktree.path;
    agentsSuggestion = worktree.agentsSuggestion;
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${err}`, sendTelegram, chatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });
  const worktreeEnv: WorktreeEnv = { envNotes: repo.envNotes, agentsSuggestion };

  try {
    for (const stage of STAGE_ORDER) {
      await runCodingStage(stage, { taskId, task, worktreePath, artifactsDir, worktreeEnv, sendTelegram });
      await requireArtifact(artifactsDir, STAGES[stage].artifact, STAGES[stage].artifactError);
    }

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
    await notifyTelegram(sendTelegram, chatId,
      `Task ${task.id.slice(0, 8)} complete. Handing off to PR session...`);

    // PR session runs independently; don't await.
    startPrSession({
      originTaskId: taskId,
      repo: task.repo,
      branch,
      worktreePath,
      artifactsDir,
      sendTelegram,
      chatId: chatId!,
    }).catch((err) => {
      log.error(`PR session failed for task ${taskId}`, err);
      notifyTelegram(sendTelegram, chatId,
        `PR session failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, chatId);
  } finally {
    clearActiveSession(taskId);
  }
}

// --- Stage runner ---

interface StageContext {
  taskId: string;
  task: { telegramChatId: string | null; description: string; repo: string };
  worktreePath: string;
  artifactsDir: string;
  worktreeEnv: WorktreeEnv;
  sendTelegram: SendTelegram;
}

async function runCodingStage(stage: CodingStage, ctx: StageContext): Promise<void> {
  const absArtifacts = path.resolve(ctx.artifactsDir);
  const spec = STAGES[stage];
  const { systemPrompt, initialPrompt } = await codingPrompts(
    stage, ctx.task.repo, absArtifacts, ctx.worktreeEnv, ctx.task.description,
  );

  // Only the planner delegates to subagents. Other stages stay on
  // --no-extensions for reproducibility.
  const cap = stage === "planner" ? subagentCapability() : null;

  await runStage({
    taskId: ctx.taskId,
    stage,
    cwd: ctx.worktreePath,
    systemPrompt,
    initialPrompt,
    model: modelFor(spec.modelKey),
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.task.telegramChatId,
    stageLabel: spec.label,
    extensions: cap?.extensions,
    envOverrides: cap?.envOverrides ?? {},
  });
}

// --- Helpers ---

function modelFor(key: keyof Env): string {
  const env = loadEnv();
  return (env[key] as string | undefined) ?? env.PI_MODEL;
}

/** Assert that an artifact file exists and is non-empty; throws with `errorMsg` otherwise. */
async function requireArtifact(artifactsDir: string, filename: string, errorMsg: string): Promise<void> {
  const filePath = path.join(artifactsDir, filename);
  try {
    const s = await stat(filePath);
    if (s.size === 0) throw new Error(`${errorMsg} (file is empty: ${filePath})`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(errorMsg)) throw err;
    throw new Error(`${errorMsg} (expected at ${filePath})`);
  }
}
