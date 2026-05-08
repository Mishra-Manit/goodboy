/**
 * Shared builders for PR review dashboard pages. The canonical review model is
 * task-owned; PR sessions are optional context for chat and watch behavior.
 */

import { readFile } from "node:fs/promises";
import { exec } from "../core/git/exec.js";
import * as queries from "../db/repository.js";
import { prReviewOutputs } from "../pipelines/pr-review/output-contracts.js";
import { readReviewArtifact } from "../pipelines/pr-review/artifacts/read-review.js";
import { refreshReviewArtifacts } from "../pipelines/pr-session/refresh-review.js";
import { taskArtifactsDir } from "../shared/artifact-paths/index.js";
import { buildPrUrl } from "../shared/domain/repos.js";
import type {
  PrReviewPageDto,
  PrReviewRunDto,
  PrReviewSessionDto,
  TaskPrReviewPageDto,
} from "../shared/contracts/pr-review.js";
import { toErrorMessage } from "../shared/runtime/errors.js";
import { createLogger } from "../shared/runtime/logger.js";

const log = createLogger("api-pr-review-page");

/** Per-session debounce so concurrent requests don't trigger overlapping refreshes. */
const refreshInFlight = new Map<string, Promise<void>>();

// --- Public API ---

/** Build the canonical task-owned PR review page. */
export async function buildTaskPrReviewPage(task: queries.Task): Promise<TaskPrReviewPageDto | null> {
  if (task.kind !== "pr_review") return null;

  const session = await resolveSessionForReviewTask(task);
  const run = await readTaskReviewRun(task.id, session);

  return {
    task: {
      id: task.id,
      repo: task.repo,
      kind: task.kind,
      description: task.description,
      status: task.status,
      prNumber: task.prNumber,
      prIdentifier: task.prIdentifier,
      prUrl: task.prUrl,
      createdAt: task.createdAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
    },
    session: session ? toReviewSessionDto(session) : null,
    run,
  };
}

/** Build the legacy session-owned PR review page. */
export async function buildSessionPrReviewPage(session: queries.PrSession): Promise<PrReviewPageDto> {
  const reviewTaskId = await resolveReviewTaskIdForSession(session);
  const run = reviewTaskId ? await readTaskReviewRun(reviewTaskId, session) : null;

  return {
    session: toReviewSessionDto(session),
    run,
  };
}

/** Resolve the exact review task displayed by a PR session convenience route. */
export async function resolveReviewTaskIdForSession(session: queries.PrSession): Promise<string | null> {
  if (session.mode === "review") return session.sourceTaskId;
  if (!session.prNumber) return null;

  const tasks = await queries.listTasksForRepoAndPr(session.repo, session.prNumber);
  return tasks.find((task) => task.kind === "pr_review")?.id ?? null;
}

// --- Helpers ---

async function readTaskReviewRun(
  taskId: string,
  session: queries.PrSession | null,
): Promise<PrReviewRunDto | null> {
  const artifactsDir = taskArtifactsDir(taskId);
  const paths = {
    review: prReviewOutputs.review.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
  };

  const reviewResult = await readReviewArtifact(paths.review);
  if (!reviewResult) return null;

  if (session) {
    await maybeRefreshDiffFromWorktree(session, taskId, reviewResult.artifact.headSha);
  }

  const diffPatch = await readFile(paths.updatedDiff, "utf8")
    .catch(() => readFile(paths.diff, "utf8"))
    .catch(() => "");

  return {
    ...reviewResult.artifact,
    diffPatch,
    createdAt: reviewResult.createdAt.toISOString(),
  };
}

async function resolveSessionForReviewTask(task: queries.Task): Promise<queries.PrSession | null> {
  const direct = await queries.getPrSessionBySourceTask(task.id);
  if (direct) return direct;
  if (!task.prNumber) return null;

  const sessions = await queries.listPrSessionsForRepoAndPr(task.repo, task.prNumber);
  return (
    sessions.find((session) => session.mode === "review" && session.status === "active") ??
    sessions.find((session) => session.mode === "own" && session.status === "active") ??
    sessions.find((session) => session.mode === "review") ??
    sessions.find((session) => session.mode === "own") ??
    null
  );
}

function toReviewSessionDto(session: queries.PrSession): PrReviewSessionDto {
  return {
    id: session.id,
    repo: session.repo,
    prNumber: session.prNumber,
    prUrl: buildPrUrl(session.repo, session.prNumber),
    branch: session.branch,
    mode: session.mode,
  };
}

/**
 * Lazy diff refresh. If the session's worktree HEAD has advanced past the cached `headSha`,
 * regenerate the updated diff artifact before serving the review page. Best-effort.
 */
async function maybeRefreshDiffFromWorktree(
  session: queries.PrSession,
  reviewTaskId: string,
  cachedHeadSha: string | undefined,
): Promise<void> {
  const { worktreePath, prNumber } = session;
  if (!worktreePath || !prNumber) return;

  const existing = refreshInFlight.get(session.id);
  if (existing) return existing;

  const work = (async () => {
    let workHead: string;
    try {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
      workHead = stdout.trim();
    } catch (err) {
      log.warn(`maybeRefreshDiffFromWorktree: rev-parse failed for ${session.id}: ${toErrorMessage(err)}`);
      return;
    }
    if (!workHead || workHead === cachedHeadSha) return;

    log.info(`Refreshing diff for PR session ${session.id}: cached=${cachedHeadSha ?? "<none>"} → worktree=${workHead}`);
    await refreshReviewArtifacts({
      prSessionId: session.id,
      sourceTaskId: reviewTaskId,
      repo: session.repo,
      prNumber,
      worktreePath,
    });
  })().finally(() => refreshInFlight.delete(session.id));

  refreshInFlight.set(session.id, work);
  return work;
}
