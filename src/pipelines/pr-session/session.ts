/**
 * Long-lived PR session: owns a pull request from creation through every
 * comment-driven revision. `startPrSession` is invoked after the coding
 * reviewer stage; `resumePrSession` is driven by the poller; and
 * `handoffExternalReview` finalizes a pr_review task by promoting it to a
 * watchable session. All three share the same pi-session + persistent
 * sessionfile machinery.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/runtime/logger.js";
import { resolveModel } from "../../shared/runtime/config.js";
import { emit } from "../../shared/runtime/events.js";
import { spawnPiSession } from "../../core/pi/spawn.js";
import {
  ensureSessionDir,
  prSessionPath,
  readSessionFile,
} from "../../core/pi/session-file.js";
import { broadcastSessionFile } from "../../core/pi/session-broadcast.js";
import * as queries from "../../db/repository.js";
import { prSessionPrompt, formatCommentsPrompt, prCreationPrompt } from "./prompts.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import { codeReviewerFeedbackBlock } from "../../core/memory/feedback/code-reviewer-feedback.js";
import { codeReviewerFeedbackCapability } from "../../core/pi/extensions.js";
import { codeReviewerFeedbackToolPolicy } from "../../shared/prompts/code-reviewer-feedback.js";
import { notifyTelegram, withTimeout, type SendTelegram } from "../../core/stage.js";
import { parsePrNumberFromUrl, revParseHead } from "../../core/git/github.js";
import { taskArtifactsDir } from "../../shared/artifacts/index.js";
import { prReviewArtifactPaths } from "../pr-review/artifacts/index.js";
import type { PrComment } from "../../shared/domain/types.js";
import type { PrReviewAnnotation } from "../../shared/contracts/pr-review.js";
import {
  reviewChatSystemPrompt,
  formatReviewChatPrompt,
  parseReviewChatResult,
  latestAssistantText,
  type ReviewChatArtifacts,
  type ReviewChatResult,
} from "./review-chat/index.js";
import { stat } from "node:fs/promises";
import { refreshReviewArtifacts } from "./refresh-review.js";
import { withPipelineSpan, bridgeSessionToOtel } from "../../observability/index.js";
import { trace } from "@opentelemetry/api";
import { Goodboy } from "../../observability/attributes.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";

const exec = promisify(execFile);
const log = createLogger("pr-session");

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// --- Lifecycle entry points ---

/** Called right after the reviewer stage. Creates the PR and persists the session for future rounds. */
export async function startPrSession(options: {
  sourceTaskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  artifactsDir: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}): Promise<void> {
  const { sourceTaskId, repo, branch, worktreePath, artifactsDir, sendTelegram, chatId } = options;

  const prSession = await queries.createPrSessionAndTransferTaskOwnership({
    repo, branch, worktreePath,
    mode: "own", sourceTaskId,
    telegramChatId: chatId,
  });

  const run = await queries.createPrSessionRun({
    prSessionId: prSession.id,
    trigger: "pr_creation",
  });
  log.info(`Starting PR session ${prSession.id} for task ${sourceTaskId}`);

  try {
    await runSessionTurn({
      prSessionId: prSession.id,
      trigger: "pr_creation",
      labelSuffix: "create",
      cwd: worktreePath,
      systemPrompt: prSessionPrompt({
        mode: "own", repo, branch,
        planPath: path.join(artifactsDir, "plan.md"),
        summaryPath: path.join(artifactsDir, "implementation-summary.md"),
        reviewPath: path.join(artifactsDir, "review.md"),
      }),
      model: resolveModel("PI_MODEL_PR_CREATOR"),
      prompt: prCreationPrompt,
      run,
      timeoutLabel: "PR session (create)",
    });

    const prUrl = await extractPrUrlFromSession(prSession.id);
    const prNumber = prUrl ? parsePrNumberFromUrl(prUrl) : null;
    await queries.updatePrSession(prSession.id, {
      ...(prNumber ? { prNumber } : {}),
      lastPolledAt: new Date(),
    });

    if (prNumber && prUrl) {
      await queries.updateTask(sourceTaskId, { prUrl, prNumber });
      await notifyTelegram(sendTelegram, chatId, `PR is up: ${prUrl}\nI will watch for comments.`);
    } else {
      await notifyTelegram(sendTelegram, chatId, "PR session finished, but I could not detect the PR URL from output. Check GitHub.");
    }
  } catch (err) {
    log.error(`PR session create failed for task ${sourceTaskId}`, err);
    await notifyTelegram(sendTelegram, chatId, `PR session failed: ${toErrorMessage(err)}`);
  }
}

/** Resume a PR session to address new comments detected by the poller. */
export async function resumePrSession(options: {
  prSessionId: string;
  comments: PrComment[];
  sendTelegram: SendTelegram;
}): Promise<void> {
  const { prSessionId, comments, sendTelegram } = options;

  const prSession = await queries.getPrSession(prSessionId);
  if (!prSession?.worktreePath) {
    log.error(`Cannot resume PR session ${prSessionId}: missing record or worktree`);
    return;
  }

  const { worktreePath, repo, branch, prNumber, mode, telegramChatId: chatId } = prSession;
  await pullLatest(worktreePath, prSessionId, branch);

  const run = await queries.createPrSessionRun({ prSessionId, trigger: "comments", comments });
  log.info(`Resuming PR session ${prSessionId} with ${comments.length} new comments`);

  const pluralS = comments.length === 1 ? "" : "s";
  await notifyTelegram(sendTelegram, chatId,
    `Found ${comments.length} new comment${pluralS} on PR #${prNumber}. Addressing now...`);

  const memory = await memoryBlock(repo);
  const reviewerFeedback = mode === "review" ? await codeReviewerFeedbackBlock(repo) : "";
  const feedbackPolicy = mode === "review" && prNumber
    ? codeReviewerFeedbackToolPolicy(repo, prNumber, "github_comment")
    : "";
  const feedbackCap = mode === "review" ? codeReviewerFeedbackCapability() : null;

  const beforeSha = await revParseHead(worktreePath);

  try {
    await runSessionTurn({
      prSessionId,
      trigger: "comments",
      labelSuffix: "resume",
      cwd: worktreePath,
      systemPrompt: memory + reviewerFeedback + prSessionPrompt({
        mode,
        repo,
        branch: branch ?? "",
        prNumber: prNumber ?? undefined,
        feedbackToolPolicy: feedbackPolicy,
      }),
      model: resolveModel("PI_MODEL_REVISION"),
      prompt: formatCommentsPrompt(comments),
      run,
      timeoutLabel: "PR session (resume)",
      extensions: feedbackCap?.extensions,
      envOverrides: feedbackCap?.envOverrides,
    });

    const afterSha = await revParseHead(worktreePath);
    if (
      beforeSha && afterSha && beforeSha !== afterSha &&
      prSession.sourceTaskId && prNumber
    ) {
      await refreshReviewArtifacts({
        prSessionId,
        sourceTaskId: prSession.sourceTaskId,
        repo,
        prNumber,
        worktreePath,
      });
    }

    await notifyTelegram(sendTelegram, chatId,
      `Addressed ${comments.length} comment${pluralS} on PR #${prNumber}. Pushed changes.`);
  } catch (err) {
    log.error(`PR session resume failed for ${prSessionId}`, err);
    await notifyTelegram(sendTelegram, chatId,
      `Failed to address comments on PR #${prNumber}: ${toErrorMessage(err)}`);
  }
}

// --- Review chat ---

/**
 * Sentinel errors thrown by `runReviewChatTurn` so the API layer can map them
 * to user-facing status codes without leaking internals.
 */
export class ReviewChatNotFoundError extends Error {
  constructor(message = "PR session not found") {
    super(message);
    this.name = "ReviewChatNotFoundError";
  }
}

export class ReviewChatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewChatUnavailableError";
  }
}

export class ReviewChatBusyError extends Error {
  constructor() {
    super("goodboy is already working on this PR");
    this.name = "ReviewChatBusyError";
  }
}

/** Run one dashboard-driven chat turn against an external reviewed PR session. */
export async function runReviewChatTurn(options: {
  prSessionId: string;
  message: string;
  activeFile: string | null;
  annotation: PrReviewAnnotation | null;
}): Promise<ReviewChatResult> {
  const { prSessionId, message, activeFile, annotation } = options;

  const session = await queries.getPrSession(prSessionId);
  if (!session) throw new ReviewChatNotFoundError();
  assertReviewChatReady(session);

  const sourceTaskId = session.sourceTaskId!;
  const worktreePath = session.worktreePath!;
  const branch = session.branch!;
  const prNumber = session.prNumber!;

  await assertWorktreeExists(worktreePath);
  const artifacts = await resolveReviewChatArtifacts(sourceTaskId);

  const existing = await queries.getRunningPrSessionRun(prSessionId);
  if (existing) throw new ReviewChatBusyError();

  await pullLatest(worktreePath, prSessionId, branch);
  const beforeSha = await revParseHead(worktreePath);

  const reviewerFeedback = await codeReviewerFeedbackBlock(session.repo);
  const feedbackPolicy = codeReviewerFeedbackToolPolicy(session.repo, prNumber, "dashboard_chat");
  const feedbackCap = codeReviewerFeedbackCapability();

  const run = await queries.createPrSessionRun({
    prSessionId,
    trigger: "review_chat",
    comments: { activeFile, annotation },
  });
  log.info(`Review chat turn for PR session ${prSessionId} (run ${run.id})`);

  let parsed: ReviewChatResult | null = null;
  try {
    await runSessionTurn({
      prSessionId,
      trigger: "review_chat",
      labelSuffix: "review-chat",
      cwd: worktreePath,
      systemPrompt: reviewerFeedback + reviewChatSystemPrompt({
        repo: session.repo,
        branch,
        prNumber,
        feedbackToolPolicy: feedbackPolicy,
      }),
      model: resolveModel("PI_MODEL_REVISION"),
      prompt: formatReviewChatPrompt({
        context: { message, activeFile, annotation },
        artifacts,
      }),
      run,
      timeoutLabel: "PR session (review-chat)",
      extensions: feedbackCap.extensions,
      envOverrides: feedbackCap.envOverrides,
    });

    const entries = await readSessionFile(prSessionPath(prSessionId));
    const reply = latestAssistantText(entries);
    parsed = reply ? parseReviewChatResult(reply) : null;
  } catch (err) {
    log.error(`Review chat turn failed for ${prSessionId}`, err);
    return { status: "failed", changed: false };
  }

  const afterSha = await revParseHead(worktreePath);
  const changed = beforeSha !== null && afterSha !== null && beforeSha !== afterSha;

  if (!parsed) {
    await queries.failPrSessionRun(run.id, "missing review_chat result marker");
    return { status: "failed", changed };
  }

  if (changed && parsed.status === "complete") {
    await refreshReviewArtifacts({
      prSessionId,
      sourceTaskId,
      repo: session.repo,
      prNumber,
      worktreePath,
    });
  }

  return { ...parsed, changed };
}

function assertReviewChatReady(session: queries.PrSession): void {
  if (session.mode !== "review") {
    throw new ReviewChatUnavailableError("Review chat is available for reviewed PRs only.");
  }
  if (!session.sourceTaskId) {
    throw new ReviewChatUnavailableError("Source review task is missing.");
  }
  if (!session.worktreePath) {
    throw new ReviewChatUnavailableError("Review worktree is no longer available.");
  }
  if (!session.branch) {
    throw new ReviewChatUnavailableError("Review branch is no longer available.");
  }
  if (!session.prNumber) {
    throw new ReviewChatUnavailableError("Review PR number is missing.");
  }
}

async function assertWorktreeExists(worktreePath: string): Promise<void> {
  try {
    const info = await stat(worktreePath);
    if (!info.isDirectory()) {
      throw new ReviewChatUnavailableError("Review worktree is not a directory.");
    }
  } catch (err) {
    if (err instanceof ReviewChatUnavailableError) throw err;
    throw new ReviewChatUnavailableError("Review worktree no longer exists on disk.");
  }
}

async function resolveReviewChatArtifacts(sourceTaskId: string): Promise<ReviewChatArtifacts> {
  const paths = prReviewArtifactPaths(taskArtifactsDir(sourceTaskId));
  for (const required of [paths.review, paths.summary, paths.diff]) {
    try {
      await stat(required);
    } catch {
      throw new ReviewChatUnavailableError(`Review artifact missing: ${path.basename(required)}`);
    }
  }
  return {
    reviewPath: paths.review,
    summaryPath: paths.summary,
    diffPath: paths.diff,
    updatedDiffPath: paths.updatedDiff,
    contextPath: paths.context,
    updatedContextPath: paths.updatedContext,
    reportsDir: paths.reportsDir,
  };
}



/**
 * Promote a finished `pr_review` task into a watchable PR session. The
 * analyst has already posted its review; this only persists the session
 * row, transfers worktree ownership, and exits. The first comment-driven
 * resume creates the JSONL on disk.
 */
export async function handoffExternalReview(options: {
  sourceTaskId: string;
  repo: string;
  prNumber: number;
  branch: string;
  worktreePath: string;
  chatId: string | null;
}): Promise<string> {
  const { sourceTaskId, repo, prNumber, branch, worktreePath, chatId } = options;

  const prSession = await queries.createPrSessionAndTransferTaskOwnership({
    repo, prNumber, branch, worktreePath,
    mode: "review", sourceTaskId,
    telegramChatId: chatId,
    lastPolledAt: new Date(),
  });

  log.info(`Handed off task ${sourceTaskId} -> PR session ${prSession.id} (review mode)`);
  return prSession.id;
}

// --- Shared session shell ---

interface SessionTurn {
  trigger: "pr_creation" | "comments" | "review_chat";
  prSessionId: string;
  labelSuffix: string;
  cwd: string;
  systemPrompt: string;
  model: string;
  prompt: string;
  run: { id: string };
  timeoutLabel: string;
  extensions?: string[];
  envOverrides?: Record<string, string>;
}

/**
 * Run one pi session turn: spawn, send prompt, wait (bounded), update run
 * status, and emit running on/off. Failure marks the run failed and rethrows
 * so the caller can do case-specific notification.
 */
async function runSessionTurn(turn: SessionTurn): Promise<void> {
  // Each turn (create / resume / review) is its own root trace, linked to the
  // long-lived PR session via `goodboy.pr_session.id`.
  return withPipelineSpan(
    { taskId: turn.run.id, kind: "pr_session" },
    async (pipelineSpan) => {
      pipelineSpan.setAttribute(Goodboy.PrSessionId, turn.prSessionId);
      pipelineSpan.setAttribute(Goodboy.PrSessionRunId, turn.run.id);
      pipelineSpan.setAttribute(Goodboy.PrSessionTrigger, turn.trigger);
      await runSessionTurnInner(turn);
    },
  );
}

async function runSessionTurnInner(turn: SessionTurn): Promise<void> {
  const {
    prSessionId,
    labelSuffix,
    cwd,
    systemPrompt,
    model,
    prompt,
    run,
    timeoutLabel,
    extensions,
    envOverrides,
  } = turn;

  emit({ type: "pr_session_update", prSessionId, running: true });
  const filePath = prSessionPath(prSessionId);
  await ensureSessionDir(filePath);
  const stopBroadcast = broadcastSessionFile(filePath, { scope: "pr_session", prSessionId });

  // Bridge pi's JSONL to OTel, parented under the active pipeline span. Safe
  // because `runSessionTurn` always invokes this from inside withPipelineSpan.
  const activeSpan = trace.getActiveSpan();
  const stopBridge = activeSpan
    ? bridgeSessionToOtel({
        sessionPath: filePath,
        stageSpan: activeSpan,
        taskId: run.id,
        initialModel: model,
      })
    : () => {};

  const session = spawnPiSession({
    id: `pr-session-${prSessionId.slice(0, 8)}-${labelSuffix}`,
    cwd,
    systemPrompt,
    model,
    sessionPath: filePath,
    extensions,
    envOverrides,
  });
  session.sendPrompt(prompt);

  try {
    await withTimeout(session.waitForCompletion(), SESSION_TIMEOUT_MS, timeoutLabel);
    await queries.completePrSessionRun(run.id);
  } catch (err) {
    await queries.failPrSessionRun(run.id, toErrorMessage(err));
    throw err;
  } finally {
    session.kill();
    await session.waitForExit();
    stopBridge();
    stopBroadcast();
    emit({ type: "pr_session_update", prSessionId, running: false });
  }
}

// --- Helpers ---

/**
 * Rebase-pull in the worktree in case comments arrived alongside manual pushes.
 * Best-effort. The branch is passed explicitly because handoff worktrees never
 * configure upstream tracking, so a bare `git pull` fails with "no tracking
 * information for the current branch."
 */
async function pullLatest(worktreePath: string, prSessionId: string, branch: string | null): Promise<void> {
  if (!branch) return;
  try {
    await exec("git", ["pull", "--rebase", "origin", branch], { cwd: worktreePath });
  } catch (err) {
    log.warn(`Git pull failed in worktree for PR session ${prSessionId}`, err);
  }
}

/**
 * Scan the PR session's own pi session file for a GitHub PR URL and return
 * the last one found. The agent may cite other PRs for context, so the last
 * match is treated as the one just created.
 */
async function extractPrUrlFromSession(prSessionId: string): Promise<string | null> {
  const entries = await readSessionFile(prSessionPath(prSessionId));
  const urls: string[] = [];
  const pattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "text") continue;
      const matches = block.text.match(pattern);
      if (matches) urls.push(...matches);
    }
  }
  return urls[urls.length - 1] ?? null;
}
