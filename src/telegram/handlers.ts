import { getRepo, listRepoNames } from "../shared/repos.js";
import { createLogger } from "../shared/logger.js";
import * as queries from "../db/queries.js";
import { runPipeline } from "../pipelines/coding/pipeline.js";
import { runQuestion } from "../pipelines/question/pipeline.js";
import { runPrReview } from "../pipelines/pr-review/pipeline.js";
import { cancelTask, type SendTelegram } from "../core/stage.js";
import type { Intent } from "./intent-classifier.js";
import type { Task } from "../db/queries.js";
import type { TaskKind } from "../shared/types.js";

const log = createLogger("telegram");

interface Ctx {
  chatId: string;
  sendTelegram: SendTelegram;
  reply: (text: string) => Promise<void>;
}

// --- Helpers (pure) ---------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function formatTaskLine(task: Task, prefix = ""): string {
  return `${prefix}[${shortId(task.id)}] ${task.repo}: ${task.status}\n${prefix ? "  " : ""}${truncate(task.description, 80)}`;
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

// --- Task creation ----------------------------------------------------------

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

// --- Task management --------------------------------------------------------

async function handleTaskStatus(intent: Extract<Intent, { type: "task_status" }>, ctx: Ctx): Promise<void> {
  if (intent.taskPrefix) {
    const result = await findTaskByPrefix(intent.taskPrefix);
    await ctx.reply(result.ok ? formatTaskLine(result.task) : result.message);
    return;
  }

  const active = (await queries.listTasks()).filter(
    (t) => !["complete", "failed", "cancelled"].includes(t.status),
  );

  if (active.length === 0) {
    await ctx.reply("No active tasks.");
    return;
  }

  const lines = active.map((t) => formatTaskLine(t, "- "));
  await ctx.reply(`Active tasks:\n${lines.join("\n")}`);
}

async function handleTaskCancel(intent: Extract<Intent, { type: "task_cancel" }>, ctx: Ctx): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) {
    await ctx.reply(result.message);
    return;
  }

  cancelTask(result.task.id);
  await queries.updateTask(result.task.id, { status: "cancelled" });
  await ctx.reply(`Cancelled task ${shortId(result.task.id)}.`);
}

async function handleTaskRetry(intent: Extract<Intent, { type: "task_retry" }>, ctx: Ctx): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) {
    await ctx.reply(result.message);
    return;
  }

  const { task } = result;
  if (task.status !== "failed") {
    await ctx.reply(`Task ${shortId(task.id)} is not in failed state (current: ${task.status}).`);
    return;
  }

  await queries.updateTask(task.id, { status: "queued", error: null });
  await ctx.reply(`Retrying task ${shortId(task.id)}...`);

  runPipeline(task.id, ctx.sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

// --- Dispatcher -------------------------------------------------------------

const UNKNOWN_REPLY =
  "I didn't understand that. You can ask me to work on a task, check status, or cancel/retry tasks.";

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
          description: `Review PR ${intent.prIdentifier}`,
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
      await ctx.reply(UNKNOWN_REPLY);
      return;
  }
}
