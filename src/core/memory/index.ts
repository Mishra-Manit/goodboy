/**
 * Per-repo memory store. Owns path resolution, .state.json schema (v2
 * with zones), .zones.json sidecar schema, atomic skip-on-contention lock,
 * dedicated memory-worktree lifecycle, orphan scanning, git diff helpers,
 * memory-file loading for prompt injection, batched cold-start file
 * manifest, and diff-path-to-zone routing. All structural decisions (what
 * the zones are) live in the cold agent, not here.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { createLogger } from "../../shared/runtime/logger.js";
import { config, loadEnv } from "../../shared/runtime/config.js";
import { stageSubagentAssets } from "../subagents/index.js";
import { pruneWorktrees } from "../git/worktree.js";

const exec = promisify(execFile);
const log = createLogger("memory");

// --- Constants ---

export const ROOT_MEMORY_FILES = [
  "overview.md", "architecture.md", "patterns.md", "map.md", "glossary.md",
] as const;
export type RootMemoryFile = (typeof ROOT_MEMORY_FILES)[number];

export const ZONE_MEMORY_FILES = ["overview.md", "map.md"] as const;
export type ZoneMemoryFile = (typeof ZONE_MEMORY_FILES)[number];

export const ROOT_DIR = "_root";

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Paths matching any of these are dropped from the cold-start manifest
 * before the agent sees it. Keep the list to high-noise / low-signal
 * dirs and non-source blobs; anything a human reader would skim past.
 */
const MANIFEST_EXCLUDES = [
  /\/dist\//, /\/build\//, /\/node_modules\//,
  /__snapshots__/, /\.lock$/, /\.generated\./,
  /\.(png|jpg|jpeg|gif|ico|pdf|zip|woff2?|ttf|mp3|mp4)$/i,
] as const;

const ZONE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// --- Schemas ---

const zoneSchema = z.object({
  name: z.string().regex(ZONE_NAME_RE).refine((n) => n !== ROOT_DIR, {
    message: `zone name cannot be "${ROOT_DIR}"`,
  }),
  path: z.string().min(1).refine((p) => !p.startsWith("/") && !p.endsWith("/"), {
    message: "zone path must be repo-relative without leading/trailing slash",
  }),
  summary: z.string().min(1).max(500),
});
export type Zone = z.infer<typeof zoneSchema>;

export const memoryStateSchema = z.object({
  version: z.literal(2),
  lastIndexedSha: z.string().min(1),
  lastIndexedAt: z.string().datetime(),
  instanceId: z.string().min(1),
  zones: z.array(zoneSchema),
});
export type MemoryState = z.infer<typeof memoryStateSchema>;

export const zonesSidecarSchema = z.object({
  zones: z.array(zoneSchema),
});
export type ZonesSidecar = z.infer<typeof zonesSidecarSchema>;

export const lockSchema = z.object({
  taskId: z.string(),
  pid: z.number(),
  timestamp: z.string(),
});
export type Lock = z.infer<typeof lockSchema>;

// --- Pure helpers ---

export function memoryDir(repo: string): string {
  return path.join(config.artifactsDir, `memory-${loadEnv().INSTANCE_ID}-${repo}`);
}
export function memoryStatePath(repo: string): string {
  return path.join(memoryDir(repo), ".state.json");
}
export function zonesSidecarPath(repo: string): string {
  return path.join(memoryDir(repo), ".zones.json");
}
export function memoryLockPath(repo: string): string {
  return path.join(memoryDir(repo), ".lock");
}
export function rootMemoryDir(repo: string): string {
  return path.join(memoryDir(repo), ROOT_DIR);
}
export function zoneMemoryDir(repo: string, zoneName: string): string {
  return path.join(memoryDir(repo), zoneName);
}

/**
 * Dedicated reusable worktree used as the memory agent's cwd. Nested
 * inside memoryDir so everything for one repo lives in one place; the
 * agent still must not write into this subdir (enforced via prompt +
 * post-run `git status --porcelain`).
 */
export function memoryWorktreeDir(repo: string): string {
  return path.join(memoryDir(repo), "checkout");
}

/** Whether a lock holder counts as stale. Pure. */
export function isLockStale(
  timestamp: string, pid: number,
  now: Date = new Date(),
  pidAlive: (pid: number) => boolean = pidIsAlive,
): boolean {
  const age = now.getTime() - new Date(timestamp).getTime();
  if (age > LOCK_STALE_MS) return true;
  return !pidAlive(pid);
}

// --- Lock inspection (shared by tryAcquireLock, cancelTask, and startup sweep) ---

/**
 * Discriminated inspection of a repo's `.lock` file. The one place that
 * reads + parses + staleness-checks the lock, so `tryAcquireLock`, the
 * cancellation path, and the startup sweep cannot drift.
 */
export type LockInspection =
  | { type: "absent" }
  | { type: "corrupt" }
  | { type: "stale"; data: Lock }
  | { type: "fresh"; data: Lock };

export async function inspectLock(repo: string): Promise<LockInspection> {
  let raw: string;
  try {
    raw = await readFile(memoryLockPath(repo), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { type: "absent" };
    throw err;
  }

  let parsed: ReturnType<typeof lockSchema.safeParse>;
  try {
    parsed = lockSchema.safeParse(JSON.parse(raw));
  } catch {
    return { type: "corrupt" };
  }
  if (!parsed.success) return { type: "corrupt" };

  return isLockStale(parsed.data.timestamp, parsed.data.pid)
    ? { type: "stale", data: parsed.data }
    : { type: "fresh", data: parsed.data };
}

// --- In-process registry of locks currently held by tasks ---
//
// `withMemoryRun` populates this between `tryAcquireLock` and its
// `finally`-release. `cancelTask` consults it so it can drop the `.lock`
// file on disk if the pipeline crashes before `withMemoryRun`'s finally
// runs. Happy-path cancellation already cleans up via `runStage` killing
// the pi child -> `withMemoryRun` finally -> `releaseLock`; this map is
// the belt-and-suspenders recovery path.

const locksHeldByTask = new Map<string, string>(); // taskId -> repo

export function registerHeldLock(taskId: string, repo: string): void {
  locksHeldByTask.set(taskId, repo);
}

export function unregisterHeldLock(taskId: string): void {
  locksHeldByTask.delete(taskId);
}

/**
 * Release any memory lock currently held by `taskId`. No-op when the task
 * is not a lock holder. Does NOT signal any process: the lock's `pid` is
 * always the goodboy server itself (see `tryAcquireLock`), so signalling
 * it would SIGTERM our own server.
 */
export async function releaseMemoryLockForTask(taskId: string): Promise<boolean> {
  const repo = locksHeldByTask.get(taskId);
  if (!repo) return false;
  locksHeldByTask.delete(taskId);
  try {
    await rm(memoryLockPath(repo), { force: true });
    return true;
  } catch (err) {
    log.warn(`Failed to release memory lock for task ${taskId} repo ${repo}`, err);
    return false;
  }
}

/**
 * Sweep all repos for stale memory locks on startup. A lock is stale if
 * its timestamp is older than `LOCK_STALE_MS` or its recorded pid is no
 * longer alive. After a server restart every previously-recorded pid is
 * dead, so this is effectively how we recover from unclean shutdowns.
 *
 * Corrupt lock files are also removed. Fresh locks (held by *another*
 * live goodboy on the same machine) are left alone.
 */
export async function cleanupStaleMemoryLocks(
  repos: readonly string[],
): Promise<Array<{ repo: string; previousTaskId: string | null; reason: "stale" | "corrupt" }>> {
  const cleared: Array<{ repo: string; previousTaskId: string | null; reason: "stale" | "corrupt" }> = [];
  for (const repo of repos) {
    let inspection: LockInspection;
    try {
      inspection = await inspectLock(repo);
    } catch (err) {
      log.warn(`inspectLock failed for ${repo} during startup sweep`, err);
      continue;
    }
    if (inspection.type === "absent" || inspection.type === "fresh") continue;

    try {
      await rm(memoryLockPath(repo), { force: true });
    } catch (err) {
      log.warn(`Failed to remove ${inspection.type} lock for ${repo}`, err);
      continue;
    }
    cleared.push({
      repo,
      previousTaskId: inspection.type === "stale" ? inspection.data.taskId : null,
      reason: inspection.type,
    });
  }
  return cleared;
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Bucket a list of changed file paths into zones. A path belongs to the
 * first zone whose path prefix matches; unmatched paths go to _root.
 * Returns a map keyed by zone name (including "_root").
 */
export function bucketPathsByZone(
  paths: readonly string[], zones: readonly Zone[],
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  buckets.set(ROOT_DIR, []);
  for (const z of zones) buckets.set(z.name, []);

  for (const p of paths) {
    const zone = zones.find((z) => p === z.path || p.startsWith(`${z.path}/`));
    const key = zone ? zone.name : ROOT_DIR;
    buckets.get(key)!.push(p);
  }
  return buckets;
}

/**
 * Detect new top-level subtrees appearing in the diff that aren't covered
 * by any zone. Surfaces to the warm agent as a "consider rebuilding" hint.
 */
export function findUnzonedSubtrees(
  paths: readonly string[], zones: readonly Zone[],
): readonly string[] {
  const covered = new Set<string>();
  for (const p of paths) {
    const inZone = zones.some((z) => p === z.path || p.startsWith(`${z.path}/`));
    if (inZone) continue;
    const top = p.split("/").slice(0, 2).join("/");
    covered.add(top);
  }
  return [...covered].filter((top) => top.includes("/"));
}

// --- State IO ---

export async function readState(repo: string): Promise<MemoryState | null> {
  try {
    const raw = await readFile(memoryStatePath(repo), "utf8");
    const parsed = memoryStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn(`Invalid state.json for ${repo}: ${parsed.error.message}`);
      return null;
    }
    if (parsed.data.instanceId !== loadEnv().INSTANCE_ID) {
      log.warn(`state.json instanceId mismatch for ${repo}; ignoring`);
      return null;
    }
    return parsed.data;
  } catch { return null; }
}

export async function writeState(
  repo: string, sha: string, zones: readonly Zone[],
): Promise<void> {
  await mkdir(memoryDir(repo), { recursive: true });
  const state: MemoryState = {
    version: 2,
    lastIndexedSha: sha,
    lastIndexedAt: new Date().toISOString(),
    instanceId: loadEnv().INSTANCE_ID,
    zones: [...zones],
  };
  const tmp = `${memoryStatePath(repo)}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, memoryStatePath(repo));
}

/** Read .zones.json written by the cold agent. Null if missing or invalid. */
export async function readZonesSidecar(repo: string): Promise<readonly Zone[] | null> {
  try {
    const raw = await readFile(zonesSidecarPath(repo), "utf8");
    const parsed = zonesSidecarSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn(`Invalid .zones.json for ${repo}: ${parsed.error.message}`);
      return null;
    }
    const names = new Set<string>();
    for (const z of parsed.data.zones) {
      if (names.has(z.name)) {
        log.warn(`Duplicate zone name "${z.name}" in ${repo}`);
        return null;
      }
      names.add(z.name);
    }
    return parsed.data.zones;
  } catch { return null; }
}

// --- Lock (atomic create via wx flag) ---

/**
 * Atomic skip-on-contention lock. Uses exclusive-create (wx) so two
 * concurrent callers cannot both succeed. On EEXIST, inspects the lock
 * for staleness and retries once if stale.
 */
export async function tryAcquireLock(repo: string, taskId: string): Promise<boolean> {
  await mkdir(memoryDir(repo), { recursive: true });
  const p = memoryLockPath(repo);
  const payload = JSON.stringify({
    taskId, pid: process.pid, timestamp: new Date().toISOString(),
  });

  const tryCreate = async (): Promise<"acquired" | "exists"> => {
    try {
      await writeFile(p, payload, { flag: "wx" });
      return "acquired";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    }
  };

  const first = await tryCreate();
  if (first === "acquired") return true;

  // Holder present. Delegate staleness check to the shared inspector.
  const inspection = await inspectLock(repo);
  if (inspection.type === "fresh") return false;

  // Absent/corrupt/stale: remove and retry exactly once.
  try { await rm(p, { force: true }); } catch { /* ignore */ }
  const second = await tryCreate();
  return second === "acquired";
}

export async function releaseLock(repo: string): Promise<void> {
  try { await rm(memoryLockPath(repo), { force: true }); }
  catch (err) { log.warn(`Failed to release memory lock for ${repo}`, err); }
}

// --- Git ---

export async function currentHeadSha(repoPath: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  return stdout.trim();
}

export async function gitDiffFiles(
  repoPath: string, fromSha: string, toSha: string,
): Promise<readonly string[] | null> {
  try {
    const { stdout } = await exec(
      "git", ["diff", "--name-only", fromSha, toSha],
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch (err) {
    log.warn(`git diff ${fromSha}..${toSha} failed in ${repoPath}`, err);
    return null;
  }
}

// --- File loading (for prompt injection and validation) ---

/** Load all memory files from _root + every zone. Missing files silently omitted. */
export async function readAllMemory(
  repo: string, zones: readonly Zone[],
): Promise<{
  root: Partial<Record<RootMemoryFile, string>>;
  zones: Array<{ zone: Zone; files: Partial<Record<ZoneMemoryFile, string>> }>;
}> {
  const root: Partial<Record<RootMemoryFile, string>> = {};
  for (const name of ROOT_MEMORY_FILES) {
    try { root[name] = await readFile(path.join(rootMemoryDir(repo), name), "utf8"); }
    catch { /* missing is fine */ }
  }
  const zoneData = [];
  for (const z of zones) {
    const files: Partial<Record<ZoneMemoryFile, string>> = {};
    for (const name of ZONE_MEMORY_FILES) {
      try { files[name] = await readFile(path.join(zoneMemoryDir(repo, z.name), name), "utf8"); }
      catch { /* missing */ }
    }
    zoneData.push({ zone: z, files });
  }
  return { root, zones: zoneData };
}

/** Post-run validation: _root has >=1 of 5, every zone has >=1 of 2. */
export function memoryFilesValid(repo: string, zones: readonly Zone[]): {
  valid: boolean; reason?: string;
} {
  const rootOk = ROOT_MEMORY_FILES.some((f) => existsSync(path.join(rootMemoryDir(repo), f)));
  if (!rootOk) return { valid: false, reason: "no _root memory files written" };
  for (const z of zones) {
    const ok = ZONE_MEMORY_FILES.some((f) => existsSync(path.join(zoneMemoryDir(repo, z.name), f)));
    if (!ok) return { valid: false, reason: `zone "${z.name}" has no memory files` };
  }
  return { valid: true };
}

/** Hash of .state.json — used by warm to prove the agent didn't touch it. */
export async function stateFileHash(repo: string): Promise<string | null> {
  try {
    const { createHash } = await import("node:crypto");
    const buf = await readFile(memoryStatePath(repo));
    return createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

// --- Memory worktree ---

/**
 * Ensure the dedicated memory worktree exists and is pinned clean to
 * origin/main. Called at the top of every memory run. Source of truth
 * for what the agent sees. Never shared with per-task worktrees.
 *
 * Prunes the main clone's worktree registry first so stale entries
 * (e.g. from an externally-deleted checkout dir) don't block `add`.
 */
export async function ensureMemoryWorktree(
  repo: string, mainRepoPath: string,
): Promise<string> {
  const wt = memoryWorktreeDir(repo);
  await mkdir(memoryDir(repo), { recursive: true });
  await pruneWorktrees(mainRepoPath);

  if (!existsSync(wt)) {
    await exec("git", ["fetch", "origin", "main", "--quiet"], { cwd: mainRepoPath });
    await exec("git", ["worktree", "add", "-f", "--detach", wt, "origin/main"], {
      cwd: mainRepoPath,
    });
  } else {
    await exec("git", ["fetch", "origin", "main", "--quiet"], { cwd: wt });
    await exec("git", ["reset", "--hard", "origin/main"], { cwd: wt });
    await exec("git", ["clean", "-fdx"], { cwd: wt });
  }

  await stageSubagentAssets(wt);
  return wt;
}

/** Porcelain cleanliness check. Pure over git output. */
export async function assertMemoryWorktreeClean(
  repo: string,
): Promise<{ clean: boolean; dirty: readonly string[] }> {
  const wt = memoryWorktreeDir(repo);
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: wt });
    const dirty = stdout.trim().split("\n").filter(Boolean);
    return { clean: dirty.length === 0, dirty };
  } catch (err) {
    log.warn(`git status failed in memory worktree for ${repo}`, err);
    return { clean: false, dirty: ["<git status failed>"] };
  }
}

/**
 * Resource wrapper for a memory run. Owns the full lock + worktree
 * lifecycle so the caller only writes the business logic:
 *
 *   acquire lock (skip-on-contention) -> ensure worktree exists and is
 *   clean -> run body(worktree) -> reset worktree -> release lock.
 *
 * Returns `"lock_held"` when another run is active and the body never ran.
 * Throws from body propagate through the cleanup finally blocks unchanged.
 */
export async function withMemoryRun(
  repo: string,
  repoPath: string,
  taskId: string,
  body: (worktree: string) => Promise<void>,
): Promise<"ran" | "lock_held"> {
  const acquired = await tryAcquireLock(repo, taskId);
  if (!acquired) return "lock_held";
  registerHeldLock(taskId, repo);

  try {
    await mkdir(memoryDir(repo), { recursive: true });
    const worktree = await ensureMemoryWorktree(repo, repoPath);
    try {
      await body(worktree);
    } finally {
      // Always reset the worktree — even on success. It's a view, not storage.
      await resetMemoryWorktree(repo);
    }
  } finally {
    unregisterHeldLock(taskId);
    await releaseLock(repo);
  }
  return "ran";
}

/**
 * Zone directories that currently exist on disk for `repo`. Excludes the
 * `_root` directory, the nested `checkout` worktree, and any dotfile. Used
 * by the warm validator to prove the agent didn't create a new zone dir.
 */
export async function listZoneDirs(repo: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir(repo), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== ROOT_DIR && e.name !== "checkout" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

/** Hard-reset the memory worktree. Called after every run, success or not. */
export async function resetMemoryWorktree(repo: string): Promise<void> {
  const wt = memoryWorktreeDir(repo);
  try {
    await exec("git", ["reset", "--hard", "HEAD"], { cwd: wt });
    await exec("git", ["clean", "-fdx"], { cwd: wt });
  } catch (err) {
    log.warn(`Failed to reset memory worktree for ${repo}`, err);
  }
}

// --- Manifest (cold, batched) ---

/** Parallelism cap for per-file reads during manifest build. Bounded to avoid FD exhaustion on monorepos. */
const MANIFEST_READ_CONCURRENCY = 32;

const NEWLINE_BYTE = 0x0a;

/**
 * Tracked files annotated with line counts, filtered for noise. Files are
 * discovered with `git ls-files -z` and read in parallel from Node; a failed
 * read (binary blob, permission error, race with worktree reset) degrades
 * the line count to `?` without failing the whole manifest.
 */
export async function buildFileManifest(repoPath: string, subdir?: string): Promise<string> {
  const args = subdir
    ? ["ls-files", "-z", "--", subdir]
    : ["ls-files", "-z"];
  const { stdout: lsOut } = await exec("git", args, {
    cwd: repoPath, maxBuffer: 50 * 1024 * 1024,
  });
  const files = lsOut.split("\0")
    .filter(Boolean)
    .filter((f) => !MANIFEST_EXCLUDES.some((r) => r.test(f)));
  if (files.length === 0) return "";

  const counts = await countLinesParallel(repoPath, files, MANIFEST_READ_CONCURRENCY);
  return files.map((f) => `${f}\t${counts.get(f) ?? "?"}`).join("\n");
}

/** Count newline bytes in one file. Returns null on any read error. */
async function countFileLines(absPath: string): Promise<number | null> {
  try {
    const buf = await readFile(absPath);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === NEWLINE_BYTE) count += 1;
    }
    return count;
  } catch { return null; }
}

/** Read every file's line count with a concurrency cap so monorepos don't exhaust FDs. */
async function countLinesParallel(
  repoPath: string, files: readonly string[], concurrency: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const rel = files[i];
      const lines = await countFileLines(path.join(repoPath, rel));
      if (lines !== null) counts.set(rel, lines);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, worker);
  await Promise.all(workers);
  return counts;
}

// --- Status + orphans ---

export async function memoryStatus(repo: string): Promise<{
  state: MemoryState | null;
  fileCount: number;
  totalBytes: number;
}> {
  const state = await readState(repo);
  let fileCount = 0;
  let totalBytes = 0;
  const checkDir = async (dir: string, files: readonly string[]) => {
    for (const name of files) {
      try { const s = await stat(path.join(dir, name)); fileCount += 1; totalBytes += s.size; }
      catch { /* missing */ }
    }
  };
  await checkDir(rootMemoryDir(repo), ROOT_MEMORY_FILES);
  for (const z of state?.zones ?? []) {
    await checkDir(zoneMemoryDir(repo, z.name), ZONE_MEMORY_FILES);
  }
  return { state, fileCount, totalBytes };
}

/**
 * Orphaned memory dirs: entries under artifactsDir named
 * `memory-<INSTANCE>-<repo>` whose repo is not in REGISTERED_REPOS.
 * Because the checkout is nested inside the memory dir, a single scan
 * here covers both the memory store and its worktree.
 */
export async function findOrphanedMemoryDirs(
  registered: readonly string[],
): Promise<readonly { repo: string; path: string }[]> {
  const prefix = `memory-${loadEnv().INSTANCE_ID}-`;
  try {
    const entries = await readdir(config.artifactsDir);
    return entries
      .filter((e) => e.startsWith(prefix))
      .map((e) => ({ repo: e.slice(prefix.length), path: path.join(config.artifactsDir, e) }))
      .filter((o) => !registered.includes(o.repo));
  } catch { return []; }
}
