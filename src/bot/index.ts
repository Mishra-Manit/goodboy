import { Bot } from "grammy";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { classifyMessage } from "../shared/classifier.js";
import { listRepos, getRepo } from "../shared/repos.js";
import * as queries from "../db/queries.js";
import { runPipeline, runQuestion, runPrReview, deliverReply, cancelTask } from "../orchestrator/index.js";
import type { SendTelegram } from "../orchestrator/index.js";
import type { Intent } from "../shared/classifier.js";
import type { Task } from "../db/queries.js";

const log = createLogger("bot");

/** Track which task a user is currently conversing with */
const activeConversations = new Map<string, string>(); // chatId -> taskId

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findTaskByPrefix(
  prefix: string,
): Promise<{ ok: true; task: Task } | { ok: false; message: string }> {
  const tasks = await queries.listTasks();
  const matches = tasks.filter((t) => t.id.startsWith(prefix));
  if (matches.length === 0) return { ok: false, message: `Task not found: ${prefix}` };
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 8)).join(", ");
    return { ok: false, message: `Ambiguous ID -- matches: ${ids}. Use more characters.` };
  }
  return { ok: true, task: matches[0] };
}

function repoNames(): readonly string[] {
  return listRepos().map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------

async function handleCodingTask(
  intent: Extract<Intent, { type: "coding_task" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const repo = getRepo(intent.repo);
  if (!repo) {
    await reply(`Repo '${intent.repo}' not found. Available: ${repoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: intent.repo,
    kind: "coding_task",
    description: intent.description,
    telegramChatId: chatId,
  });

  activeConversations.set(chatId, task.id);
  await reply(`Task created: ${task.id.slice(0, 8)}\nStarting planner...`);

  runPipeline(task.id, sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

async function handleCodebaseQuestion(
  intent: Extract<Intent, { type: "codebase_question" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const repo = getRepo(intent.repo);
  if (!repo) {
    await reply(`Repo '${intent.repo}' not found. Available: ${repoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: intent.repo,
    kind: "codebase_question",
    description: intent.question,
    telegramChatId: chatId,
  });

  await reply(`Question received: ${task.id.slice(0, 8)}\nSearching the codebase...`);

  runQuestion(task.id, sendTelegram).catch((err) => {
    log.error(`Question error for task ${task.id}`, err);
  });
}

async function handlePrReview(
  intent: Extract<Intent, { type: "pr_review" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const repo = getRepo(intent.repo);
  if (!repo) {
    await reply(`Repo '${intent.repo}' not found. Available: ${repoNames().join(", ")}`);
    return;
  }

  const task = await queries.createTask({
    repo: intent.repo,
    kind: "pr_review",
    description: `Review PR ${intent.prIdentifier}`,
    telegramChatId: chatId,
    prIdentifier: intent.prIdentifier,
  });

  await reply(`PR review started: ${task.id.slice(0, 8)}\nReviewing PR ${intent.prIdentifier}...`);

  runPrReview(task.id, sendTelegram).catch((err) => {
    log.error(`PR review error for task ${task.id}`, err);
  });
}

async function handleTaskStatus(
  intent: Extract<Intent, { type: "task_status" }>,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  if (intent.taskPrefix) {
    const result = await findTaskByPrefix(intent.taskPrefix);
    if (!result.ok) {
      await reply(result.message);
      return;
    }
    const { task } = result;
    const desc =
      task.description.length > 80
        ? `${task.description.slice(0, 77)}...`
        : task.description;
    await reply(`[${task.id.slice(0, 8)}] ${task.repo}: ${task.status}\n${desc}`);
    return;
  }

  const tasks = await queries.listTasks();
  const active = tasks.filter(
    (t) => !["complete", "failed", "cancelled"].includes(t.status),
  );

  if (active.length === 0) {
    await reply("No active tasks.");
    return;
  }

  const lines = active.map((t) => {
    const desc =
      t.description.length > 80
        ? `${t.description.slice(0, 77)}...`
        : t.description;
    return `- [${t.id.slice(0, 8)}] ${t.repo}: ${t.status}\n  ${desc}`;
  });
  await reply(`Active tasks:\n${lines.join("\n")}`);
}

async function handleTaskCancel(
  intent: Extract<Intent, { type: "task_cancel" }>,
  chatId: string,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) {
    await reply(result.message);
    return;
  }

  cancelTask(result.task.id);
  await queries.updateTask(result.task.id, { status: "cancelled" });
  activeConversations.delete(chatId);
  await reply(`Cancelled task ${result.task.id.slice(0, 8)}.`);
}

async function handleTaskRetry(
  intent: Extract<Intent, { type: "task_retry" }>,
  chatId: string,
  sendTelegram: SendTelegram,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const result = await findTaskByPrefix(intent.taskPrefix);
  if (!result.ok) {
    await reply(result.message);
    return;
  }

  const { task } = result;
  if (task.status !== "failed") {
    await reply(
      `Task ${task.id.slice(0, 8)} is not in failed state (current: ${task.status}).`,
    );
    return;
  }

  await queries.updateTask(task.id, { status: "queued", error: null });
  activeConversations.set(chatId, task.id);
  await reply(`Retrying task ${task.id.slice(0, 8)}...`);

  runPipeline(task.id, sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

async function handlePlanConfirm(
  chatId: string,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const taskId = activeConversations.get(chatId);
  if (!taskId) {
    await reply("No task waiting for confirmation.");
    return;
  }

  const delivered = deliverReply(taskId, "/go");
  activeConversations.delete(chatId);

  if (delivered) {
    await reply("Proceeding with implementation...");
  } else {
    await reply("Task has already proceeded.");
  }
}

async function handlePlanReply(
  intent: Extract<Intent, { type: "plan_reply" }>,
  chatId: string,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const taskId = activeConversations.get(chatId);
  if (!taskId) {
    await reply("No active conversation to reply to.");
    return;
  }

  const delivered = deliverReply(taskId, intent.reply);
  if (delivered) {
    await reply("Got it, passing to the planner...");
  } else {
    activeConversations.delete(chatId);
    await reply("Previous task is no longer waiting for input.");
  }
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

export function createBot(): Bot {
  const env = loadEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Auth middleware -- restrict to single user
  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== env.TELEGRAM_USER_ID) {
      log.warn(`Unauthorized access attempt from user ${ctx.from?.id}`);
      return;
    }
    return next();
  });

  const sendTelegram: SendTelegram = async (chatId, text) => {
    await bot.api.sendMessage(Number(chatId), text);
  };

  // All text messages go through the classifier
  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;
    const hasActiveConversation = activeConversations.has(chatId);

    const reply = async (msg: string): Promise<void> => {
      await ctx.reply(msg);
    };

    const intent = await classifyMessage(text, repoNames(), hasActiveConversation);

    switch (intent.type) {
      case "coding_task":
        await handleCodingTask(intent, chatId, sendTelegram, reply);
        break;

      case "pr_review":
        await handlePrReview(intent, chatId, sendTelegram, reply);
        break;

      case "codebase_question":
        await handleCodebaseQuestion(intent, chatId, sendTelegram, reply);
        break;

      case "task_status":
        await handleTaskStatus(intent, reply);
        break;

      case "task_cancel":
        await handleTaskCancel(intent, chatId, reply);
        break;

      case "task_retry":
        await handleTaskRetry(intent, chatId, sendTelegram, reply);
        break;

      case "plan_confirm":
        await handlePlanConfirm(chatId, reply);
        break;

      case "plan_reply":
        await handlePlanReply(intent, chatId, reply);
        break;

      case "unknown":
        await reply(
          "I didn't understand that. You can ask me to work on a task, check status, cancel or retry tasks, or answer planner questions.",
        );
        break;
    }
  });

  bot.catch((err) => {
    log.error("Bot error", {
      error: err.message,
      update: err.ctx?.update?.update_id,
    });
  });

  return bot;
}
