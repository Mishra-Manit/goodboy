import { Bot } from "grammy";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { listRepoNames } from "../shared/repos.js";
import { classifyMessage } from "./intent-classifier.js";
import { handleIntent } from "./handlers.js";
import type { SendTelegram } from "../core/stage.js";

const log = createLogger("telegram");

export function createTelegramBot(): Bot {
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

  // All text messages go through the intent classifier.
  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const intent = await classifyMessage(ctx.message.text, listRepoNames());
    await handleIntent(intent, {
      chatId,
      sendTelegram,
      reply: async (msg) => {
        await ctx.reply(msg);
      },
    });
  });

  bot.catch((err) => {
    log.error("Telegram bot error", {
      error: err.message,
      update: err.ctx?.update?.update_id,
    });
  });

  return bot;
}
