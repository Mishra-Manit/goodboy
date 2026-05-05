/**
 * Coding task pipeline: sync repo -> worktree -> planner -> implementer ->
 * reviewer -> pr_creator -> complete. Each stage runs via `runStage` and
 * is fully visible in the dashboard. After pr_creator succeeds, the task is
 * marked complete and a `pr_sessions` row is registered for comment watching.
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
  prCreatorPrompts,
  type CodingStage,
  type WorktreeEnv,
} from "./prompts.js";
import { codingStageOutput } from "./output-contracts.js";
import { registerOwnedPrSession } from "../pr-session/session.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import {
  handlePipelineError,
  prepareTaskPipeline,
  withTaskPipeline,
  type TaskPipelineContext,
} from "../common.js";
import { readLatestAssistantText, taskSessionPath } from "../../core/pi/session-file.js";
import { parseBareFinalJson } from "../../shared/agent-output/final-response.js";
import { prCreationFinalResponseContract } from "../../shared/agent-output/contracts.js";
import { parsePrNumberFromUrl } from "../../core/git/github.js";
import { getRepoNwo } from "../../shared/domain/repos.js";

const log = createLogger("coding");

interface StageSpec {
  readonly label: string;
  readonly modelKey: Parameters<typeof resolveModel>[0];
}

const STAGES: Record<CodingStage, StageSpec> = {
  planner: {
    label: "Planner",
    modelKey: "PI_MODEL_PLANNER",
  },
  implementer: {
    label: "Implementer",
    modelKey: "PI_MODEL_IMPLEMENTER",
  },
  reviewer: {
    label: "Reviewer",
    modelKey: "PI_MODEL_REVIEWER",
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
    }

    const githubRepo = getRepoNwo(task.repo);
    if (!githubRepo) {
      await failTask(taskId, `Repo '${task.repo}' has no GitHub URL configured.`, sendTelegram, chatId);
      return;
    }

    const { prUrl, prNumber } = await runPrCreatorStage({
      taskId, task, worktreePath, artifactsDir, worktreeEnv, memory, sendTelegram,
      branch, githubRepo, repo: task.repo,
    });

    await queries.updateTask(taskId, { prUrl, prNumber });
    await completeTask(taskId);
    await registerOwnedPrSession({
      sourceTaskId: taskId,
      repo: task.repo,
      branch,
      worktreePath,
      prNumber,
      chatId,
      sendTelegram,
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
  const output = codingStageOutput(stage).resolve(absArtifacts, undefined);
  const { systemPrompt, initialPrompt } = codingPrompts(
    stage, ctx.memory, absArtifacts, ctx.worktreeEnv, ctx.task.description,
  );

  // Only the planner delegates to subagents. Other stages stay on
  // --no-extensions for reproducibility.
  const cap = stage === "planner" ? subagentCapability() : null;

  const result = await runStage({
    taskId: ctx.taskId,
    stage,
    cwd: ctx.worktreePath,
    systemPrompt,
    initialPrompt,
    model: resolveModel(spec.modelKey),
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.task.telegramChatId,
    stageLabel: spec.label,
    outputs: [output],
    extensions: cap?.extensions,
    envOverrides: cap?.envOverrides ?? {},
  });

  if (!result.ok) {
    throw new Error(`${spec.label} validation failed: ${result.reason}`);
  }
}

// --- PR Creator stage runner ---

interface PrCreatorStageContext extends StageContext {
  branch: string;
  githubRepo: string;
  repo: string;
}

/**
 * Run the pr_creator stage end-to-end. Uses a custom postValidate because
 * the final response schema `{"status":"complete","prUrl":"..."}` is a strict
 * superset of the default `{"status":"complete"}` and would fail the standard
 * check. The PR URL is extracted from the session file and returned so the
 * pipeline can persist it on the task row before calling completeTask.
 */
async function runPrCreatorStage(
  ctx: PrCreatorStageContext,
): Promise<{ prUrl: string; prNumber: number }> {
  const absArtifacts = path.resolve(ctx.artifactsDir);
  const sessionPath = taskSessionPath(ctx.taskId, "pr_creator");
  const { systemPrompt, initialPrompt } = prCreatorPrompts({
    branch: ctx.branch,
    githubRepo: ctx.githubRepo,
    repo: ctx.repo,
    artifactsDir: absArtifacts,
    env: ctx.worktreeEnv,
  });

  const result = await runStage<{ prUrl: string; prNumber: number }>({
    taskId: ctx.taskId,
    stage: "pr_creator",
    cwd: ctx.worktreePath,
    systemPrompt,
    initialPrompt,
    model: resolveModel("PI_MODEL_PR_CREATOR"),
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.task.telegramChatId,
    stageLabel: "PR Creator",
    outputs: [],
    validateFinalResponse: false,
    postValidate: async () => {
      const text = await readLatestAssistantText(sessionPath);
      if (!text) return { valid: false, reason: "PR creator final response is missing" };
      const parsed = parseBareFinalJson(text, prCreationFinalResponseContract.schema);
      if (!parsed) {
        return {
          valid: false,
          reason: `PR creator final response must match: ${prCreationFinalResponseContract.example}`,
        };
      }
      const prNumber = parsePrNumberFromUrl(parsed.prUrl);
      if (!prNumber) {
        return { valid: false, reason: `PR creator returned an invalid GitHub PR URL: ${parsed.prUrl}` };
      }
      return { valid: true, data: { prUrl: parsed.prUrl, prNumber } };
    },
  });

  if (!result.ok) throw new Error(`PR Creator validation failed: ${result.reason}`);
  return result.data!;
}

// --- Helpers ---
