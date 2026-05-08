/**
 * Long-lived PR session lifecycle: owns a pull request through every
 * comment-driven revision. `registerOwnedPrSession` is called after the
 * pr_creator stage to register a new owned session for comment watching;
 * `resumePrSession` is driven by the poller; and `handoffExternalReview`
 * finalizes a pr_review task by promoting it to a watchable session.
 * All three share the same pi-session + persistent sessionfile machinery
 * (except `registerOwnedPrSession`, which creates no pi session).
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/runtime/logger.js";
import { resolveModel } from "../../shared/runtime/config.js";
import { emit } from "../../shared/runtime/events.js";
import { spawnPiSession } from "../../core/pi/spawn.js";
import { createPrSessionWorktree, worktreeExists } from "../../core/git/worktree.js";
import {
  ensureSessionDir,
  prSessionPath,
  clearPrSessionFile,
  readLatestAssistantText,
  readSessionFile,
} from "../../core/pi/session-file.js";
import { broadcastSessionFile } from "../../core/pi/session-broadcast.js";
import * as queries from "../../db/repository.js";
import { prSessionPrompt, formatCommentsPrompt } from "./prompts.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import { codeReviewerFeedbackBlock } from "../../core/memory/feedback/code-reviewer-feedback.js";
import { codeReviewerFeedbackCapability } from "../../core/pi/extensions.js";
import { codeReviewerFeedbackToolPolicy } from "../../shared/prompts/code-reviewer-feedback.js";
import { notifyTelegram, withTimeout, type SendTelegram } from "../../core/stage.js";
import { parsePrNumberFromUrl, revParseHead } from "../../core/git/github.js";
import { taskArtifactsDir } from "../../shared/artifact-paths/index.js";
import { parseBareFinalJson, parseFinalLineJson } from "../../shared/agent-output/final-response.js";
import {
  prCreationFinalResponseContract,
  reviewChatFinalResponseContract,
  stageCompleteFinalResponseContract,
  type FinalResponseContract,
} from "../../shared/agent-output/contracts.js";
import { prReviewOutputs, prReviewReportsDir } from "../pr-review/output-contracts.js";
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
import { getRepo } from "../../shared/domain/repos.js";

const exec = promisify(execFile);
const log = createLogger("pr-session");

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// --- Lifecycle entry points ---

/**
 * Register a pr_session row for an owned coding task after its PR has been
 * created by the pr_creator pipeline stage. Transfers branch/worktree
 * ownership from the task to the session and starts watching for comments.
 * Does NOT spawn a pi session — PR creation already happened in the stage.
 */
export async function registerOwnedPrSession(options: {
  sourceTaskId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  prNumber: number;
  chatId: string | null;
  sendTelegram: SendTelegram;
}): Promise<string> {
  const { sourceTaskId, repo, branch, worktreePath, prNumber, chatId, sendTelegram } = options;

  const prSession = await queries.createPrSessionAndTransferTaskOwnership({
    repo, branch, worktreePath, prNumber,
    mode: "own", sourceTaskId,
    telegramChatId: chatId,
    lastPolledAt: new Date(),
  });

  log.info(`Registered owned PR session ${prSession.id} for task ${sourceTaskId} (PR #${prNumber})`);
  await notifyTelegram(sendTelegram, chatId, `PR #${prNumber} is up. Watching for comments.`);
  return prSession.id;
}

/** Resume a PR session to address new comments detected by the poller. */
export async function resumePrSession(options: {
  prSessionId: string;
  comments: PrComment[];
  sendTelegram: SendTelegram;
}): Promise<boolean> {
  const { prSessionId, comments, sendTelegram } = options;

  const prSession = await queries.getPrSession(prSessionId);
  if (!prSession) {
    log.error(`Cannot resume PR session ${prSessionId}: missing record`);
    return false;
  }

  const { repo, branch, prNumber, mode, telegramChatId: chatId } = prSession;
  const worktreePath = await ensureResumeWorktree(prSession, sendTelegram);
  if (!worktreePath) return false;
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
    return true;
  } catch (err) {
    log.error(`PR session resume failed for ${prSessionId}`, err);
    await notifyTelegram(sendTelegram, chatId,
      `Failed to address comments on PR #${prNumber}: ${toErrorMessage(err)}`);
    return false;
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
      finalResponseMode: "finalLineJson",
      finalResponseContract: reviewChatFinalResponseContract,
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

/** Ensure comment-driven resumes never spawn pi inside a stale cwd. */
async function ensureResumeWorktree(
  session: queries.PrSession,
  sendTelegram: SendTelegram,
): Promise<string | null> {
  const { id, repo, branch, worktreePath, telegramChatId: chatId, prNumber } = session;
  if (worktreePath && await worktreeExists(worktreePath)) return worktreePath;

  if (!branch) {
    await muteBrokenSession(id, sendTelegram, chatId, `PR session ${id} has no branch to recreate.`);
    return null;
  }

  const registeredRepo = getRepo(repo);
  if (!registeredRepo) {
    await muteBrokenSession(id, sendTelegram, chatId, `Repo '${repo}' is no longer registered.`);
    return null;
  }

  try {
    log.warn(`Recreating missing PR session worktree for ${id}: ${worktreePath ?? "<none>"}`);
    const nextPath = await createPrSessionWorktree(registeredRepo.localPath, branch, id);
    await queries.updatePrSession(id, { worktreePath: nextPath });
    await clearPrSessionFile(id);
    return nextPath;
  } catch (err) {
    await muteBrokenSession(
      id,
      sendTelegram,
      chatId,
      `Could not recreate worktree for PR #${prNumber ?? "?"}: ${toErrorMessage(err)}`,
    );
    return null;
  }
}

async function muteBrokenSession(
  prSessionId: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
  reason: string,
): Promise<void> {
  log.error(reason);
  await queries.updatePrSession(prSessionId, { watchStatus: "muted" });
  await notifyTelegram(sendTelegram, chatId, `${reason}\nMuted this PR session so it will not crash or retry-loop.`);
}

async function resolveReviewChatArtifacts(sourceTaskId: string): Promise<ReviewChatArtifacts> {
  const artifactsDir = taskArtifactsDir(sourceTaskId);
  const paths = {
    review: prReviewOutputs.review.resolve(artifactsDir, undefined).path,
    summary: prReviewOutputs.summary.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    context: prReviewOutputs.context.resolve(artifactsDir, undefined).path,
    updatedContext: prReviewOutputs.updatedContext.resolve(artifactsDir, undefined).path,
    reportsDir: prReviewReportsDir(artifactsDir),
  };
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

interface SessionTurn<TFinalResponse = unknown> {
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
  finalResponseMode?: "bareJson" | "finalLineJson";
  finalResponseContract?: FinalResponseContract<TFinalResponse>;
}

/**
 * Run one pi session turn: spawn, send prompt, wait (bounded), update run
 * status, and emit running on/off. Failure marks the run failed and rethrows
 * so the caller can do case-specific notification.
 */
async function runSessionTurn<TFinalResponse = unknown>(
  turn: SessionTurn<TFinalResponse>,
): Promise<TFinalResponse> {
  // Each turn (create / resume / review) is its own root trace, linked to the
  // long-lived PR session via `goodboy.pr_session.id`.
  return withPipelineSpan(
    { taskId: turn.run.id, kind: "pr_session" },
    async (pipelineSpan) => {
      pipelineSpan.setAttribute(Goodboy.PrSessionId, turn.prSessionId);
      pipelineSpan.setAttribute(Goodboy.PrSessionRunId, turn.run.id);
      pipelineSpan.setAttribute(Goodboy.PrSessionTrigger, turn.trigger);
      return runSessionTurnInner(turn);
    },
  );
}

async function runSessionTurnInner<TFinalResponse = unknown>(
  turn: SessionTurn<TFinalResponse>,
): Promise<TFinalResponse> {
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

  try {
    session.sendPrompt(prompt);
    await withTimeout(session.waitForCompletion(), SESSION_TIMEOUT_MS, timeoutLabel);
    const contract = (
      turn.finalResponseContract ?? stageCompleteFinalResponseContract
    ) as FinalResponseContract<TFinalResponse>;
    const finalResponse = await validateSessionFinalResponse(
      filePath,
      turn.finalResponseMode ?? "bareJson",
      contract,
    );
    await queries.completePrSessionRun(run.id);
    return finalResponse;
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


async function validateSessionFinalResponse<TFinalResponse>(
  filePath: string,
  mode: "bareJson" | "finalLineJson",
  contract: FinalResponseContract<TFinalResponse>,
): Promise<TFinalResponse> {
  const text = await readLatestAssistantText(filePath);
  if (!text) throw new Error("PR session final response is missing");
  const parsed = mode === "bareJson"
    ? parseBareFinalJson(text, contract.schema)
    : parseFinalLineJson(text, contract.schema);
  if (!parsed) {
    const expected = mode === "bareJson" ? contract.example : `final-line marker ${contract.example}`;
    throw new Error(`PR session final response must satisfy ${expected}`);
  }
  return parsed;
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
