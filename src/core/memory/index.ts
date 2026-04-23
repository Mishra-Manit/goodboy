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
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";

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

const lockSchema = z.object({
  taskId: z.string(),
  pid: z.number(),
  timestamp: z.string(),
});

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

  // Holder present. Check staleness.
  let stale = false;
  try {
    const parsed = lockSchema.safeParse(JSON.parse(await readFile(p, "utf8")));
    if (!parsed.success) stale = true;
    else stale = isLockStale(parsed.data.timestamp, parsed.data.pid);
  } catch { stale = true; /* corrupt → treat as stale */ }

  if (!stale) return false;

  // Stale: remove and retry exactly once.
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
  try { await exec("git", ["worktree", "prune"], { cwd: mainRepoPath }); }
  catch (err) { log.warn(`git worktree prune failed in ${mainRepoPath}`, err); }

  if (!existsSync(wt)) {
    await exec("git", ["fetch", "origin", "main", "--quiet"], { cwd: mainRepoPath });
    await exec("git", ["worktree", "add", "-f", "--detach", wt, "origin/main"], {
      cwd: mainRepoPath,
    });
    return wt;
  }

  await exec("git", ["fetch", "origin", "main", "--quiet"], { cwd: wt });
  await exec("git", ["reset", "--hard", "origin/main"], { cwd: wt });
  await exec("git", ["clean", "-fdx"], { cwd: wt });
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

/**
 * Tracked files annotated with line counts, filtered for noise. One
 * batched `wc -l` call over all files at once — not per-file spawn.
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

  // One xargs -0 wc -l invocation, null-delimited to survive exotic paths.
  // Returns "<count> <path>" per line plus a total summary; parse and drop total.
  const { spawn } = await import("node:child_process");
  const lineCounts = await new Promise<Record<string, number>>((resolve, reject) => {
    const child = spawn("xargs", ["-0", "wc", "-l"], {
      cwd: repoPath, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== 123) return reject(new Error(`xargs wc exited ${code}: ${err}`));
      const counts: Record<string, number> = {};
      for (const raw of out.split("\n")) {
        const line = raw.trim();
        if (!line || line.endsWith(" total")) continue;
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (m) counts[m[2]] = Number(m[1]);
      }
      resolve(counts);
    });
    child.stdin.write(files.join("\0"));
    child.stdin.end();
  });

  return files.map((f) => `${f}\t${lineCounts[f] ?? "?"}`).join("\n");
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
