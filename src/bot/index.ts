import { Bot } from "grammy";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import * as queries from "../db/queries.js";
import { listRepos, getRepo } from "../shared/repos.js";
import { runPipeline, deliverReply, cancelTask } from "../orchestrator/index.js";
import type { SendTelegram } from "../orchestrator/index.js";

const log = createLogger("bot");

/** Track which task a user is currently conversing with */
const activeConversations = new Map<string, string>(); // chatId -> taskId

import type { Task } from "../db/queries.js";

async function findTaskByPrefix(prefix: string): Promise<
  | { ok: true; task: Task }
  | { ok: false; message: string }
> {
  const tasks = await queries.listTasks();
  const matches = tasks.filter((t) => t.id.startsWith(prefix));
  if (matches.length === 0) return { ok: false, message: `Task not found: ${prefix}` };
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 8)).join(", ");
    return { ok: false, message: `Ambiguous ID -- matches: ${ids}. Use more characters.` };
  }
  return { ok: true, task: matches[0] };
}

export function createBot(): Bot {
  const env = loadEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  const allowedUserId = env.TELEGRAM_USER_ID;

  // Auth middleware -- restrict to single user
  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== allowedUserId) {
      log.warn(`Unauthorized access attempt from user ${ctx.from?.id}`);
      return;
    }
    return next();
  });

  const sendTelegram: SendTelegram = async (chatId, text) => {
    await bot.api.sendMessage(Number(chatId), text);
  };

  // --- Commands ---

  bot.command("repos", async (ctx) => {
    const repos = listRepos();
    if (repos.length === 0) {
      await ctx.reply("No repos registered. Set REGISTERED_REPOS in .env.");
      return;
    }
    const list = repos.map((r) => `- ${r.name}: ${r.localPath}`).join("\n");
    await ctx.reply(`Registered repos:\n${list}`);
  });

  bot.command("status", async (ctx) => {
    const tasks = await queries.listTasks();
    const active = tasks.filter(
      (t) => !["complete", "failed", "cancelled"].includes(t.status)
    );

    if (active.length === 0) {
      await ctx.reply("No active tasks.");
      return;
    }

    const lines = active.map((t) => {
      const desc = t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
      return `- [${t.id.slice(0, 8)}] ${t.repo}: ${t.status}\n  ${desc}`;
    });
    await ctx.reply(`Active tasks:\n${lines.join("\n")}`);
  });

  bot.command("cancel", async (ctx) => {
    const taskId = ctx.match?.trim();
    if (!taskId) {
      await ctx.reply("Usage: /cancel <task_id>");
      return;
    }

    const result = await findTaskByPrefix(taskId);
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }

    cancelTask(result.task.id);
    await queries.updateTask(result.task.id, { status: "cancelled" });
    await ctx.reply(`Cancelled task ${result.task.id.slice(0, 8)}.`);
  });

  bot.command("retry", async (ctx) => {
    const taskId = ctx.match?.trim();
    if (!taskId) {
      await ctx.reply("Usage: /retry <task_id>");
      return;
    }

    const result = await findTaskByPrefix(taskId);
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }

    const { task } = result;
    if (task.status !== "failed") {
      await ctx.reply(`Task ${task.id.slice(0, 8)} is not in failed state (current: ${task.status}).`);
      return;
    }

    const chatId = String(ctx.chat.id);
    await queries.updateTask(task.id, { status: "queued", error: null });
    activeConversations.set(chatId, task.id);
    await ctx.reply(`Retrying task ${task.id.slice(0, 8)}...`);

    // Fire and forget
    runPipeline(task.id, sendTelegram).catch((err) => {
      log.error(`Pipeline error for task ${task.id}`, err);
    });
  });

  bot.command("go", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const taskId = activeConversations.get(chatId);
    if (!taskId) {
      await ctx.reply("No task waiting for confirmation.");
      return;
    }
    const delivered = deliverReply(taskId, "/go");
    activeConversations.delete(chatId);
    if (delivered) {
      await ctx.reply("Proceeding with implementation...");
    } else {
      await ctx.reply("Task has already proceeded. Check /status.");
    }
  });

  // --- Regular messages = new task or reply to planner ---

  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    // Check if this is a reply to an active conversation
    const conversationTaskId = activeConversations.get(chatId);
    if (conversationTaskId) {
      const delivered = deliverReply(conversationTaskId, text);
      if (delivered) {
        await ctx.reply("Got it, passing to the planner...");
        return;
      }
      activeConversations.delete(chatId);
      await ctx.reply("Previous task is no longer waiting for input. Treating as a new task...");
    }

    // Parse repo name from message (first word)
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply("Format: <repo_name> <task description>\n\nUse /repos to see available repos.");
      return;
    }

    const repoName = parts[0];
    const description = parts.slice(1).join(" ");

    const repo = getRepo(repoName);
    if (!repo) {
      await ctx.reply(
        `Repo '${repoName}' not found.\n\nUse /repos to see available repos.`
      );
      return;
    }

    // Create task
    const task = await queries.createTask({
      repo: repoName,
      description,
      telegramChatId: chatId,
    });

    activeConversations.set(chatId, task.id);
    await ctx.reply(`Task created: ${task.id.slice(0, 8)}\nStarting planner...`);

    // Fire and forget
    runPipeline(task.id, sendTelegram).catch((err) => {
      log.error(`Pipeline error for task ${task.id}`, err);
    });
  });

  bot.catch((err) => {
    log.error("Bot error", { error: err.message, update: err.ctx?.update?.update_id });
  });

  return bot;
}
