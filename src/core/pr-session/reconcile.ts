/**
 * Reconciles persisted PR sessions against on-disk git worktrees.
 * Missing active worktrees are either reported, recreated, or muted cleanly.
 */

import { createPrSessionWorktree, pruneWorktrees, worktreeExists } from "../git/worktree.js";
import * as queries from "../../db/repository.js";
import { getRepo, listRepos } from "../../shared/domain/repos.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { createLogger } from "../../shared/runtime/logger.js";
import type {
  PrSessionReconcileAction,
  PrSessionReconcileItem,
  PrSessionReconcileSummary,
} from "../../shared/contracts/wire.js";

const log = createLogger("pr-session-reconcile");

// --- Public API ---

/** Dry-run or apply repair actions for active PR-session worktrees. */
export async function reconcilePrSessions(apply: boolean): Promise<PrSessionReconcileSummary> {
  const sessions = await queries.listActivePrSessions();
  const items = await mapSeries(sessions, (session) => reconcileOne(session, apply));

  if (apply) {
    await Promise.all(listRepos().map((repo) => pruneWorktrees(repo.localPath)));
  }

  return summarize(items, apply);
}

// --- Reconciliation ---

async function reconcileOne(
  session: queries.PrSession,
  apply: boolean,
): Promise<PrSessionReconcileItem> {
  const base = {
    sessionId: session.id,
    repo: session.repo,
    prNumber: session.prNumber,
    branch: session.branch,
    oldWorktreePath: session.worktreePath,
  };

  if (session.worktreePath && await worktreeExists(session.worktreePath)) {
    return { ...base, action: "healthy" };
  }

  if (!session.branch) {
    if (apply) await queries.updatePrSession(session.id, { watchStatus: "muted" });
    return { ...base, action: apply ? "muted" : "would_mute", error: "session has no branch" };
  }

  const repo = getRepo(session.repo);
  if (!repo) {
    if (apply) await queries.updatePrSession(session.id, { watchStatus: "muted" });
    return { ...base, action: apply ? "muted" : "would_mute", error: "repo is not registered" };
  }

  if (!apply) return { ...base, action: "would_recreate" };

  try {
    const newWorktreePath = await createPrSessionWorktree(repo.localPath, session.branch, session.id);
    await queries.updatePrSession(session.id, { worktreePath: newWorktreePath, watchStatus: "watching" });
    return { ...base, action: "recreated", newWorktreePath };
  } catch (err) {
    const error = toErrorMessage(err);
    log.warn(`Failed to recreate PR session worktree ${session.id}: ${error}`);
    await queries.updatePrSession(session.id, { watchStatus: "muted" });
    return { ...base, action: "muted", error };
  }
}

// --- Helpers ---

function summarize(
  items: readonly PrSessionReconcileItem[],
  applied: boolean,
): PrSessionReconcileSummary {
  const count = (action: PrSessionReconcileAction) => items.filter((item) => item.action === action).length;
  return {
    applied,
    scanned: items.length,
    healthy: count("healthy"),
    wouldRecreate: count("would_recreate"),
    recreated: count("recreated"),
    wouldMute: count("would_mute"),
    muted: count("muted"),
    errors: items.filter((item) => item.error).length,
    items,
  };
}

async function mapSeries<T, U>(items: readonly T[], fn: (item: T) => Promise<U>): Promise<U[]> {
  return items.reduce<Promise<U[]>>(async (previous, item) => (
    [...await previous, await fn(item)]
  ), Promise.resolve([]));
}
