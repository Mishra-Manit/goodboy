/** Server-owned E2E launch routes so dashboard SSE and cancellation stay live. */

import type { Hono } from "hono";
import { z } from "zod";
import { createAndStartTask } from "../../pipelines/task-launcher.js";
import type { SendTelegram } from "../../core/stage.js";

const DEFAULT_E2E_CHAT_ID = "goodboy-e2e";
const noopSend: SendTelegram = async () => {};

const ownedBodySchema = z.object({
  repo: z.string().min(1),
  prompt: z.string().min(1),
  chatId: z.string().min(1).optional(),
});

const reviewBodySchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  chatId: z.string().min(1).optional(),
});

/** Register manual E2E smoke-test launch endpoints. */
export function registerE2ERoutes(app: Hono): void {
  app.post("/api/e2e/owned", async (c) => {
    const parsed = ownedBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid owned E2E request" }, 400);

    const launched = await createAndStartTask({
      repo: parsed.data.repo,
      kind: "coding_task",
      description: parsed.data.prompt,
      telegramChatId: parsed.data.chatId ?? DEFAULT_E2E_CHAT_ID,
    }, noopSend);
    if (launched.ok === false) return c.json({ error: launched.reason }, 404);

    return c.json({ ok: true, task: launched.task }, 201);
  });

  app.post("/api/e2e/pr-review", async (c) => {
    const parsed = reviewBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid PR review E2E request" }, 400);

    const launched = await createAndStartTask({
      repo: parsed.data.repo,
      kind: "pr_review",
      description: `Review PR #${parsed.data.prNumber}`,
      telegramChatId: parsed.data.chatId ?? DEFAULT_E2E_CHAT_ID,
      prIdentifier: String(parsed.data.prNumber),
    }, noopSend);
    if (launched.ok === false) return c.json({ error: launched.reason }, 404);

    return c.json({ ok: true, task: launched.task }, 201);
  });
}
