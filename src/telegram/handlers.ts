/**
 * Telegram intent handlers. Dispatches the classified `Intent` to the right
 * pipeline (create-and-start) or task management action (status, cancel,
 * retry). All replies go back through the `Ctx` object.
 */

import { getRepo, listRepoNames } from "../shared/repos.js";
import { createLogger } from "../shared/logger.js";
import * as queries from "../db/repository.js";
import { runPipeline } from "../pipelines/coding/pipeline.js";
import { runQuestion } from "../pipelines/question/pipeline.js";
import { runPrReview } from "../pipelines/pr-review/pipeline.js";
import { cancelTask, type SendTelegram } from "../core/stage.js";
import type { Intent } from "./intent-classifier.js";
import type { Task } from "../db/repository.js";
import type { TaskKind } from "../shared/types.js";

const log = createLogger("telegram");

const DESCRIPTION_PREVIEW_LEN = 80;
const TERMINAL_STATUSES = ["complete", "failed", "cancelled"] as const;

const UNKNOWN_REPLY =
  "I didn't understand that. You can ask me to work on a task, check status, or cancel/retry tasks.";

interface Ctx {
  chatId: string;
  sendTelegram: SendTelegram;
  reply: (text: string) => Promise<void>;
}

type PipelineRunner = (taskId: string, send: SendTelegram) => Promise<void>;

const PIPELINES: Record<TaskKind, PipelineRunner> = {
  coding_task: runPipeline,
  codebase_question: runQuestion,
  pr_review: runPrReview,
};

const ACK_MESSAGES: Record<TaskKind, string> = {
  coding_task: "Task created",
  codebase_question: "Question received",
  pr_review: "PR review queued",
};

// --- Dispatcher ---

export async function handleIntent(intent: Intent, ctx: Ctx): Promise<void> {
  switch (intent.type) {
    case "coding_task":
      return createAndStart({ kind: "coding_task", repo: intent.repo, description: intent.description }, ctx);
    case "codebase_question":
      return createAndStart({ kind: "codebase_question", repo: intent.repo, description: intent.question }, ctx);
    case "pr_review":
      return createAndStart(
        {
          kind: "pr_review",
          repo: intent.repo,
          description: intent.prIdentifier,
          prIdentifier: intent.prIdentifier,
        },
        ctx,
      );
    case "task_status":
      return handleTaskStatus(intent, ctx);
    case "task_cancel":
      return handleTaskCancel(intent, ctx);
    case "task_retry":
      return handleTaskRetry(intent, ctx);
    case "unknown":
      return ctx.reply(UNKNOWN_REPLY);
  }
}

// --- Task creation ---

interface CreateTaskInput {
  kind: TaskKind;
  repo: string;
  description: string;
  prIdentifier?: string;
}

async function createAndStart(input: CreateTaskInput, ctx: Ctx): Promise<void> {
  if (!getRepo(input.repo)) {
    await ctx.reply(`Repo '${input.repo}' not found. Available: ${listRepoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: input.repo,
    kind: input.kind,
    description: input.description,
    telegramChatId: ctx.chatId,
    prIdentifier: input.prIdentifier,
  });
  await ctx.reply(`${ACK_MESSAGES[input.kind]}: ${shortId(task.id)}`);

  PIPELINES[input.kind](task.id, ctx.sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

// --- Task management ---

async function handleTaskStatus(intent: Extract<Intent, { type: "task_status" }>, ctx: Ctx): Promise<void> {
  if (intent.taskPrefix) {
    const result = await findTaskByPrefix(intent.taskPrefix);
    await ctx.reply(result.ok ? formatTaskLine(result.task) : result.message);
    return;
  }

  const active = (await queries.listTasks()).filter((t) => !isTerminal(t.status));
  if (active.length === 0) {
    await ctx.reply("No active tasks.");
    return;
  }
  const lines = active.map((t) => formatTaskLine(t, "- "));
  await ctx.reply(`Active tasks:\n${lines.join("\n")}`);
}

async function handleTaskCancel(intent: Extract<Intent, { type: "task_cancel" }>, ctx: Ctx): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) return void ctx.reply(result.message);

  cancelTask(result.task.id);
  await queries.updateTask(result.task.id, { status: "cancelled" });
  await ctx.reply(`Cancelled task ${shortId(result.task.id)}.`);
}

async function handleTaskRetry(intent: Extract<Intent, { type: "task_retry" }>, ctx: Ctx): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) return void ctx.reply(result.message);

  const { task } = result;
  if (task.status !== "failed") {
    await ctx.reply(`Task ${shortId(task.id)} is not in failed state (current: ${task.status}).`);
    return;
  }

  await queries.updateTask(task.id, { status: "queued", error: null });
  await ctx.reply(`Retrying task ${shortId(task.id)}...`);
  PIPELINES[task.kind](task.id, ctx.sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

// --- Helpers (pure) ---

function shortId(id: string): string {
  return id.slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function formatTaskLine(task: Task, prefix = ""): string {
  const indent = prefix ? "  " : "";
  return `${prefix}[${shortId(task.id)}] ${task.repo}: ${task.status}\n${indent}${truncate(task.description, DESCRIPTION_PREVIEW_LEN)}`;
}

type TaskLookup = { ok: true; task: Task } | { ok: false; message: string };

async function findTaskByPrefix(prefix: string): Promise<TaskLookup> {
  const matches = (await queries.listTasks()).filter((t) => t.id.startsWith(prefix));
  if (matches.length === 0) return { ok: false, message: `Task not found: ${prefix}` };
  if (matches.length > 1) {
    const ids = matches.map((t) => shortId(t.id)).join(", ");
    return { ok: false, message: `Ambiguous ID -- matches: ${ids}. Use more characters.` };
  }
  return { ok: true, task: matches[0] };
}
