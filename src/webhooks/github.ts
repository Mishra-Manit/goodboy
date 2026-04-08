import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import * as queries from "../db/queries.js";
import { spawnPiSession } from "../orchestrator/pi-rpc.js";
import { revisionPrompt } from "../orchestrator/prompts.js";
import { emit } from "../shared/events.js";

const log = createLogger("webhook");

export function createWebhookHandler(): Hono {
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    const env = loadEnv();

    // Verify signature
    const signature = c.req.header("x-hub-signature-256");
    const body = await c.req.text();

    if (!verifySignature(body, signature ?? "", env.GITHUB_WEBHOOK_SECRET)) {
      log.warn("Invalid webhook signature");
      return c.json({ error: "Invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event");
    const payload = JSON.parse(body);

    log.info(`Received GitHub webhook: ${event}`);

    if (event === "pull_request_review" && payload.review?.state === "changes_requested") {
      await handleReviewFeedback(payload);
    }

    if (event === "pull_request_review_comment" || event === "issue_comment") {
      await handleComment(payload);
    }

    return c.json({ ok: true });
  });

  return app;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = `sha256=${hmac.digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function handleReviewFeedback(payload: Record<string, unknown>): Promise<void> {
  const pr = payload.pull_request as Record<string, unknown>;
  const prNumber = pr.number as number;
  const review = payload.review as Record<string, unknown>;
  const feedback = review.body as string;

  const task = await queries.findTaskByPrNumber(prNumber);
  if (!task) {
    log.warn(`No task found for PR #${prNumber}`);
    return;
  }

  await spawnRevision(task.id, task.worktreePath!, feedback);
}

async function handleComment(payload: Record<string, unknown>): Promise<void> {
  const issue = (payload.issue ?? payload.pull_request) as Record<string, unknown>;
  if (!issue) return;

  const prNumber = issue.number as number;
  const comment = payload.comment as Record<string, unknown>;
  const body = comment.body as string;

  // Ignore bot comments
  const user = comment.user as Record<string, unknown>;
  if ((user.type as string) === "Bot") return;

  const task = await queries.findTaskByPrNumber(prNumber);
  if (!task) {
    log.warn(`No task found for PR #${prNumber}`);
    return;
  }

  await spawnRevision(task.id, task.worktreePath!, body);
}

async function spawnRevision(
  taskId: string,
  worktreePath: string,
  feedback: string
): Promise<void> {
  log.info(`Starting revision for task ${taskId}`);

  await queries.updateTask(taskId, { status: "revision", currentStage: "revision" });
  emit({ type: "task_update", taskId, status: "revision" });

  const stageRecord = await queries.createTaskStage({ taskId, stage: "revision" });
  emit({ type: "stage_update", taskId, stage: "revision", status: "running" });

  const session = spawnPiSession({
    id: `${taskId}-revision`,
    cwd: worktreePath,
    systemPrompt: revisionPrompt(feedback),
    onLogLine: (line) => {
      emit({ type: "log", taskId, stage: "revision", line });
    },
  });

  session.sendPrompt("Address the PR feedback and push changes.");

  const result = await session.waitForCompletion();

  await queries.updateTaskStage(stageRecord.id, {
    status: result.marker?.status === "complete" ? "complete" : "failed",
    completedAt: new Date(),
  });

  emit({ type: "stage_update", taskId, stage: "revision", status: "complete" });
  log.info(`Revision complete for task ${taskId}`);
}
