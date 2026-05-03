/**
 * Coding task pipeline: sync repo -> worktree -> planner -> implementer ->
 * reviewer -> hand off to a PR session. Marks the task complete before
 * handoff; the PR session owns its own lifecycle from that point on.
 */

import path from "node:path";
import { createLogger } from "../../shared/runtime/logger.js";
import { resolveModel } from "../../shared/runtime/config.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { createWorktree, generateBranchName } from "../../core/git/worktree.js";
import * as queries from "../../db/repository.js";
import {
  failTask,
  notifyTelegram,
  clearActiveSession,
  isTaskCancelled,
  runStage,
  completeTask,
  type SendTelegram,
} from "../../core/stage.js";
import {
  codingPrompts,
  type CodingStage,
  type WorktreeEnv,
} from "./prompts.js";
import { startPrSession } from "../pr-session/session.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import { requireNonEmptyArtifact } from "../../shared/artifacts/index.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import {
  handlePipelineError,
  prepareTaskPipeline,
  withTaskPipeline,
  type TaskPipelineContext,
} from "../common.js";

const log = createLogger("coding");

interface StageSpec {
  readonly label: string;
  readonly modelKey: Parameters<typeof resolveModel>[0];
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
  return withTaskPipeline(taskId, "coding_task", sendTelegram, async (ctx) => {
    await runCodingPipelineInner(ctx);
  });
}

async function runCodingPipelineInner(
  ctx: TaskPipelineContext,
): Promise<void> {
  const { taskId, task, repo, chatId, sendTelegram } = ctx;

  const prepared = await prepareTaskPipeline({
    ctx,
    startMessage: `Task ${task.id.slice(0, 8)} started for repo ${task.repo}.\n\n${task.description}`,
  });
  if (!prepared) return;

  const { artifactsDir } = prepared;

  // Render memory once for the whole task. All three coding stages read the
  // same snapshot, so no stage needs to re-read files from disk.
  const memory = await memoryBlock(task.repo);

  const branch = await generateBranchName(taskId, task.description);
  let worktreePath: string;
  let agentsSuggestion: string | undefined;
  try {
    const worktree = await createWorktree(repo.localPath, branch, taskId);
    worktreePath = worktree.path;
    agentsSuggestion = worktree.agentsSuggestion;
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${toErrorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });
  const worktreeEnv: WorktreeEnv = { envNotes: repo.envNotes, agentsSuggestion };

  try {
    for (const stage of STAGE_ORDER) {
      if (isTaskCancelled(taskId)) {
        log.info(`Task ${taskId} cancelled before stage ${stage}; halting pipeline`);
        return;
      }
      await runCodingStage(stage, { taskId, task, worktreePath, artifactsDir, worktreeEnv, memory, sendTelegram });
      await requireNonEmptyArtifact(artifactsDir, STAGES[stage].artifact, STAGES[stage].artifactError);
    }

    await completeTask(taskId);
    await notifyTelegram(sendTelegram, chatId,
      `Task ${task.id.slice(0, 8)} complete. Handing off to PR session...`);

    // PR session runs independently; don't await.
    startPrSession({
      sourceTaskId: taskId,
      repo: task.repo,
      branch,
      worktreePath,
      artifactsDir,
      sendTelegram,
      chatId,
    }).catch((err) => {
      log.error(`PR session failed for task ${taskId}`, err);
      notifyTelegram(sendTelegram, chatId,
        `PR session failed: ${toErrorMessage(err)}`);
    });
  } catch (err) {
    await handlePipelineError({
      taskId,
      err,
      sendTelegram,
      chatId,
      logCancelled: () => log.info(`Task ${taskId} cancelled mid-stage; pipeline halted`),
    });
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
  /** Pre-rendered memory block; shared across all coding stages. */
  memory: string;
  sendTelegram: SendTelegram;
}

async function runCodingStage(stage: CodingStage, ctx: StageContext): Promise<void> {
  const absArtifacts = path.resolve(ctx.artifactsDir);
  const spec = STAGES[stage];
  const { systemPrompt, initialPrompt } = codingPrompts(
    stage, ctx.memory, absArtifacts, ctx.worktreeEnv, ctx.task.description,
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
    model: resolveModel(spec.modelKey),
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.task.telegramChatId,
    stageLabel: spec.label,
    extensions: cap?.extensions,
    envOverrides: cap?.envOverrides ?? {},
  });
}

// --- Helpers ---
