/**
 * Lifecycle wrapper for one row in `memory_runs`. Owns the DB insert,
 * both terminal transitions, and the `memory_run_update` SSE emits so
 * the pipeline doesn't juggle them by hand. Best-effort throughout:
 * a DB failure is logged and swallowed, `runId` goes null, and later
 * `complete` / `fail` calls no-op.
 */

import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import * as queries from "../../db/repository.js";
import type {
  MemoryRunKind,
  MemoryRunSource,
  MemoryRunStatus,
} from "../../shared/types.js";

const log = createLogger("memory-run-tracker");

// --- Public API ---

export interface StartMemoryRunOptions {
  /** Real UUID when sourced from a persisted task; manual-test label otherwise. */
  taskId: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  /** Path to the pi session JSONL, or null when the run has no pi session (skip/noop). */
  sessionPath: string | null;
}

export interface MemoryRunTracker {
  /** The `memory_runs.id`, or null if the initial DB insert failed. */
  readonly runId: string | null;
  /** Mark complete with optional sha/zoneCount. Emits one terminal SSE. No-ops when `runId` is null. */
  complete(data?: { sha?: string; zoneCount?: number }): Promise<void>;
  /** Mark failed with a reason. Emits one terminal SSE. No-ops when `runId` is null. */
  fail(reason: unknown): Promise<void>;
}

/**
 * Insert a `memory_runs` row and return a tracker that owns its terminal
 * transition. A DB failure downgrades the tracker to no-op rather than
 * throwing so the pipeline's own finally/catch chain stays in charge.
 */
export async function startMemoryRun(opts: StartMemoryRunOptions): Promise<MemoryRunTracker> {
  const identity = runIdentity(opts);
  let runId: string | null = null;

  try {
    const row = await queries.createMemoryRun({
      instance: loadEnv().INSTANCE_ID,
      repo: opts.repo,
      kind: opts.kind,
      sessionPath: opts.sessionPath,
      ...identity,
    });
    runId = row.id;
    emitRunUpdate(runId, opts.repo, opts.kind, "running", opts.taskId);
  } catch (err) {
    log.warn(`Failed to create memory_runs row for ${opts.repo}`, err);
  }

  return {
    get runId() { return runId; },

    async complete(data = {}) {
      if (!runId) return;
      try {
        await queries.updateMemoryRun(runId, {
          status: "complete",
          sha: data.sha ?? null,
          zoneCount: data.zoneCount ?? null,
          completedAt: new Date(),
        });
        emitRunUpdate(runId, opts.repo, opts.kind, "complete", opts.taskId);
      } catch (err) {
        log.warn(`Failed to complete memory_runs row ${runId}`, err);
      }
    },

    async fail(reason) {
      if (!runId) return;
      try {
        await queries.updateMemoryRun(runId, {
          status: "failed",
          error: stringifyReason(reason),
          completedAt: new Date(),
        });
        emitRunUpdate(runId, opts.repo, opts.kind, "failed", opts.taskId);
      } catch (err) {
        log.warn(`Failed to fail memory_runs row ${runId}`, err);
      }
    },
  };
}

// --- Helpers ---

/** Map our two sources to the DB's mutually exclusive origin columns. */
function runIdentity(opts: StartMemoryRunOptions) {
  return opts.source === "task"
    ? { source: "task" as const, originTaskId: opts.taskId, externalLabel: null }
    : { source: "manual_test" as const, originTaskId: null, externalLabel: opts.taskId };
}

function emitRunUpdate(
  runId: string,
  repo: string,
  kind: MemoryRunKind,
  status: MemoryRunStatus,
  sessionTaskId: string,
): void {
  emit({
    type: "memory_run_update",
    runId,
    repo,
    kind,
    status,
    sessionTaskId,
  });
}

function stringifyReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
