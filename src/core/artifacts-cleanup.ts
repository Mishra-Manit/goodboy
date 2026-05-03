/**
 * TTL-based sweep of per-task artifact directories under `artifacts/<taskId>/`.
 * Anything UUID-named whose mtime is older than `TASK_ARTIFACTS_TTL_MS` is
 * removed. Non-UUID entries (e.g. `memory-*` dirs) are skipped — they have
 * their own lifecycle in `core/memory`.
 */

import path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { createLogger } from "../shared/runtime/logger.js";
import { config } from "../shared/runtime/config.js";

const log = createLogger("artifacts-cleanup");

const TASK_ARTIFACTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TASK_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- Pure ---

export interface ArtifactDirEntry {
  name: string;
  mtimeMs: number;
}

/**
 * Pick UUID-shaped artifact dirs whose mtime is older than `now - ttlMs`.
 * Entries that don't match the task-UUID shape are ignored; they belong
 * to other lifecycles (memory store, ad-hoc files).
 */
export function selectExpiredTaskArtifacts(
  entries: readonly ArtifactDirEntry[],
  now: number,
  ttlMs: number,
): readonly string[] {
  const cutoff = now - ttlMs;
  return entries
    .filter((e) => TASK_DIR_RE.test(e.name) && e.mtimeMs < cutoff)
    .map((e) => e.name);
}

// --- IO ---

export interface SweepResult {
  scanned: number;
  deleted: readonly string[];
  failed: readonly { name: string; error: string }[];
}

/**
 * Delete per-task artifact directories older than the TTL. Logs a single
 * summary line; never throws. Safe on startup and on a recurring timer.
 */
export async function sweepExpiredTaskArtifacts(
  now: number = Date.now(),
  ttlMs: number = TASK_ARTIFACTS_TTL_MS,
): Promise<SweepResult> {
  const entries = await readArtifactDirEntries();
  const expired = selectExpiredTaskArtifacts(entries, now, ttlMs);

  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const name of expired) {
    try {
      await rm(path.join(config.artifactsDir, name), { recursive: true, force: true });
      deleted.push(name);
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (deleted.length > 0 || failed.length > 0) {
    log.info(
      `Swept ${deleted.length} expired task artifact dir(s) ` +
      `(scanned ${entries.length}, failed ${failed.length})`,
    );
    for (const f of failed) log.warn(`Failed to remove ${f.name}: ${f.error}`);
  }

  return { scanned: entries.length, deleted, failed };
}

// --- Timer ---

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the daily artifact sweep. Idempotent. */
export function startArtifactsSweep(): void {
  if (timer) return;
  log.info(`Artifacts sweep started (TTL ${TASK_ARTIFACTS_TTL_MS / 86_400_000}d, interval ${SWEEP_INTERVAL_MS / 3_600_000}h)`);
  void sweepExpiredTaskArtifacts().catch((err) => log.error("Initial sweep failed", err));
  timer = setInterval(() => {
    void sweepExpiredTaskArtifacts().catch((err) => log.error("Sweep cycle failed", err));
  }, SWEEP_INTERVAL_MS);
}

/** Stop the daily artifact sweep. Idempotent. */
export function stopArtifactsSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("Artifacts sweep stopped");
}

// --- Helpers ---

async function readArtifactDirEntries(): Promise<ArtifactDirEntry[]> {
  let names: string[];
  try {
    const dirents = await readdir(config.artifactsDir, { withFileTypes: true });
    names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.warn(`Failed to read ${config.artifactsDir}`, err);
    return [];
  }

  const out: ArtifactDirEntry[] = [];
  for (const name of names) {
    try {
      const s = await stat(path.join(config.artifactsDir, name));
      out.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      // entry vanished mid-scan; skip
    }
  }
  return out;
}
