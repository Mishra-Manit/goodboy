# Per-Repo Memory System Implementation Plan

**Goal:** Give every pi stage a grounded, citation-backed knowledge base per repo, stored at `artifacts/memory-<INSTANCE_ID>-<repo>/` and maintained by a new first-class `memory` stage that runs before every task. Monorepos get carved into **agent-discovered zones**, each with its own memory subdirectory. Downstream stages receive the full memory (root + every zone) concatenated into their system prompt.

**Approach:** Orchestrator picks cold vs warm on one signal — does `.state.json` exist. Cold agent builds from scratch: discovers zones, writes them to a sidecar `.zones.json`, then fills `_root` + every zone. Pipeline composes the canonical `.state.json` from the sidecar + HEAD SHA. Warm agent receives the current zone registry, current memory bodies, and the changed-files list bucketed by zone; it patches markdown only and is forbidden from editing state or zone structure. Differentiated timeouts (20 min cold, 5 min warm). All validation runs atomically inside `runStage` via a new `postValidate` hook, so the SSE stream emits exactly one terminal status per stage.

**Isolation:** The memory agent runs in a dedicated, reusable worktree nested *inside* the memory dir at `artifacts/memory-<INSTANCE_ID>-<repo>/checkout/`, pinned to `origin/main` and reset clean before every run. One directory holds everything memory-related for a repo — state, zones, memory files, and the read-only checkout. The agent never sees the main clone or any per-task worktree. A post-run `git status --porcelain` check catches any stray writes inside the checkout; the worktree is always hard-reset after validation regardless of outcome.

**Stack:** TypeScript + pi-RPC (`runStage`), pi-subagents extension (like planner), Drizzle migration for enum values, Hono API route, React block on Repos page, Logfire event for orphans.

---

## Design principles

1. **Prescriptive output, autonomous process.** Within each branch the agent picks its own workflow (how many subagents, what to read, how to carve zones, what to patch). The code does NOT encode thresholds or zone-discovery heuristics. The code DOES enforce: branch selection, output contract, structural invariants, lifecycle, environment, and filesystem sandbox (dedicated worktree + post-run cleanliness check).
2. **Cold owns structure. Warm owns content.** Only cold writes `.zones.json`. Warm may edit markdown inside existing zone directories but may not create, rename, or delete zones, and may not modify `.state.json`.
3. **Always inject everything.** Downstream stages receive every `.md` under `_root/` + every zone, concatenated. No routing, no scoping heuristics. Revisit in v2 if token cost becomes painful.
4. **Soft line targets, not hard caps.** Prompts suggest 300-400 lines per root file and 200-300 lines per zone file. Agent stretches if the material warrants. Pipeline enforces nothing about line counts.
5. **Warm cannot rebuild.** Warm is strictly a patch operation. If memory is bad, the operator manually deletes the dir to force a cold rebuild on the next task.

---

## Locked invariants

1. Location: `artifacts/memory-<INSTANCE_ID>-<repo>/`. Per-instance, gitignored.
2. First-class stage (`memory` in `STAGE_NAMES`).
3. Runs before every `coding_task` / `codebase_question` / `pr_review`. Not in `pr_session`.
4. cwd is the dedicated memory worktree nested at `artifacts/memory-<INSTANCE_ID>-<repo>/checkout/`, pinned to `origin/main` and cleaned before every run. NEVER the main clone, never a per-task worktree.
5. Soft-fail always; never `failTask` the parent.
6. Mandatory citations on every concrete claim: `[path:line]` for code-grounded claims.
7. Directory shape: `_root/` always (5 files) + zero or more agent-discovered zones (2 files each).
8. Skip-on-contention lock (not wait).
9. Full memory injected into `planner / implementer / reviewer / revision / answering / pr_reviewing`. Excluded: `pr_creator`, `memory`.
10. Orphans: warn, don't delete; log to logger + Logfire at startup.
11. **Timeouts:** cold 20 min, warm 5 min.
12. **State authority:** only cold (via `.zones.json` sidecar → pipeline composes `.state.json`) may change the zone registry. Warm is physically blocked.
13. **Write sandbox:** agent may write ONLY under `artifacts/memory-<INSTANCE_ID>-<repo>/`. Any change inside the memory worktree fails the stage and is reset. Enforced by prompt + post-run `git status --porcelain` check, which runs inside `runStage`'s `postValidate` hook (atomic with the terminal status emit).

---

## Directory + state shape

```
artifacts/memory-<INSTANCE_ID>-<repo>/       # self-contained, one dir per repo
  .state.json                                # pipeline-owned, canonical
  .zones.json                                # cold-agent handoff (regenerated each cold run)
  .lock                                      # atomic skip-on-contention lock
  _root/                                     # memory store (agent writes HERE)
    overview.md, architecture.md, patterns.md, map.md, glossary.md
  <zone-a>/                                  # memory store (agent writes HERE)
    overview.md, map.md
  <zone-b>/
    overview.md, map.md
  ...
  checkout/                                  # the agent's cwd (read-only view of origin/main)
    <full checkout>                          # reset --hard && clean -fdx before every run
```

Flat — no nested zones in v1. Repos with no meaningful subdivision end up with zero zones and just `_root/`, matching today's mental model.

**`.state.json` schema (v2):**

```ts
{
  version: 2,
  lastIndexedSha: string,
  lastIndexedAt: string,        // ISO
  instanceId: string,
  zones: Array<{
    name: string,               // slug, [a-z0-9-]+, not "_root"
    path: string,               // repo-relative prefix, no leading/trailing slash
    summary: string             // one-line; surfaced to downstream agents
  }>
}
```

**`.zones.json` schema (cold handoff):**

```ts
{
  zones: Array<{ name, path, summary }>
}
```

Version bump invalidates v1 state — any `.state.json` without `version: 2` or without `zones` is treated as missing → cold rebuild.

---

## Final file layout

```
src/
  core/memory.ts                    # NEW: state, zones, lock (atomic wx), paths, worktree mgmt, orphan scan, file loader, batched manifest, diff routing
  core/stage.ts                     # MODIFIED: add postValidate hook for atomic validation
  pipelines/memory/
    pipeline.ts                     # NEW: orchestrator, cold/warm branch, state composition (validation via postValidate)
    prompts.ts                      # NEW: cold + warm prompts (with FILE WRITE POLICY banner)
  shared/
    types.ts                        # MODIFIED: memory, skipped
    config.ts                       # MODIFIED: PI_MODEL_MEMORY
    agent-prompts.ts                # MODIFIED: memoryBlock(repo) - reads everything, no scoping
  db/
    schema.ts                       # MODIFIED: enum additions
  api/index.ts                      # MODIFIED: GET /api/memory/:repo
  pipelines/coding/pipeline.ts      # MODIFIED: invoke + inject memory
  pipelines/coding/prompts.ts       # MODIFIED: async, repo-aware
  pipelines/question/pipeline.ts    # MODIFIED: invoke + inject
  pipelines/question/prompts.ts     # MODIFIED: async, repo-aware
  pipelines/pr-session/*            # MODIFIED: inject memory into revision only
  pipelines/pr-review/pipeline.ts   # MODIFIED: TODO comment
  index.ts                          # MODIFIED: orphan scan on startup
drizzle/0004_memory_enums.sql       # NEW: generated
dashboard/src/
  lib/api.ts                        # MODIFIED: MemoryStatus + fetcher
  components/rows/RepoRow.tsx       # MODIFIED: memory status block with zones
.env.example                        # MODIFIED: PI_MODEL_MEMORY
```

---

## Task 1: Add `memory` stage and `skipped` status

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/db/schema.ts`

In `shared/types.ts`:

```ts
export const STAGE_NAMES = [
  "memory",
  "planner", "implementer", "reviewer", "pr_creator", "revision",
  "answering",
  "pr_reviewing",
] as const;

export const STAGE_STATUSES = ["running", "complete", "failed", "skipped"] as const;
```

Mirror in `db/schema.ts`'s `stageNameEnum` and `stageStatusEnum`.

**Verify:** `npm run build` clean.

**Commit:** `feat: add memory stage and skipped status`

---

## Task 2: Generate DB migration

**Files:**
- Create: `drizzle/0004_memory_enums.sql`

```
npm run db:generate
```

Additive `ALTER TYPE ... ADD VALUE` only. Do NOT `db:migrate` yet — human applies from laptop before the code that reads new values merges.

**Commit:** `feat: drizzle migration for memory enums`

---

## Task 3: Add `PI_MODEL_MEMORY`

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `.env.example`

```ts
PI_MODEL_MEMORY: z.string().optional(),
```

`.env.example`:
```
# Model for memory stage. Falls back to PI_MODEL.
PI_MODEL_MEMORY=
```

**Commit:** `feat: add PI_MODEL_MEMORY env var`

---

## Task 4: `src/core/memory.ts`

**Files:**
- Create: `src/core/memory.ts`

Pure parsers separated from IO. Owns path resolution, state + zones schemas, atomic lock, memory-worktree management, orphan scan, git helpers, memory file loading, batched cold-start manifest, diff-to-zone routing.

```ts
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
import { createLogger } from "../shared/logger.js";
import { config, loadEnv } from "../shared/config.js";

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
```

**Verify:** `npm run build`. Mental units:
- `bucketPathsByZone(["services/api/x.ts", "README.md"], [{name:"api", path:"services/api", summary:""}])` → `{ "_root": ["README.md"], "api": ["services/api/x.ts"] }`.
- `isLockStale(new Date().toISOString(), 99999)` → `true` (dead PID).

**Commit:** `feat(core): memory state v2, zones, atomic lock, memory worktree, batched manifest, diff routing, file loader`

---

## Task 5: Cold + warm prompts

**Files:**
- Create: `src/pipelines/memory/prompts.ts`

Two prompts sharing one `OUTPUT_CONTRACT`. Cold discovers zones, writes `.zones.json`, fills every zone. Warm reads zones from state, patches content, is forbidden from touching structure.

```ts
/**
 * Memory prompts. Cold discovers zones + fills every memory
 * file from scratch. Warm patches content inside existing zones only.
 * Both share the same citation discipline and section contract.
 */

import { ROOT_MEMORY_FILES, ZONE_MEMORY_FILES, ROOT_DIR, type Zone } from "../../core/memory.js";

const CITATIONS = `
CITATIONS ARE MANDATORY. Every concrete claim must cite a source file:
    "Named exports only [src/shared/config.ts:24]"
    "Worktrees clone per task [src/core/worktree.ts:45, src/core/stage.ts:12]"
If you cannot cite a claim, OMIT IT. No speculation. No "probably" / "seems".
`;

const ROOT_SECTIONS = `
_ROOT SECTIONS (exact headers required):

_root/overview.md
  # Overview
  ## What & why
  ## Stack
  ## Entry points
  ## Hard invariants
  ## Scope boundaries

_root/architecture.md
  # Architecture
  ## Top-level structure
  ## Dependency direction
  ## Core abstractions
  ## Cross-cutting systems
  ## Cross-zone contracts
  ## Request / task lifecycle

_root/patterns.md
  # Patterns
  ## Error handling
  ## Logging
  ## Async & IO
  ## Testing
  ## Data access
  ## Imports & exports
  ## File shape

_root/map.md
  # Map
  ## Zone index           (one paragraph per zone, pointing at its subdir)
  ## Top-level files      (everything outside zones)
  ## Excluded

_root/glossary.md
  # Glossary
  ## Domain vocabulary
  ## Core types
  ## External systems
  ## Configuration surface
`;

const ZONE_SECTIONS = `
ZONE SECTIONS (exact headers required):

<zone>/overview.md
  # <Zone> overview
  ## Purpose               (what this zone does, why it exists as its own subtree)
  ## Stack specifics       (anything different from root's stack)
  ## Entry points
  ## Core abstractions
  ## Local patterns        (only where they diverge from _root/patterns.md)
  ## Invariants

<zone>/map.md
  # <Zone> map
  ## Directory tree
  ## Significant files     (one-line annotation each)
  ## Local vocabulary      (zone-specific terms that would bloat _root/glossary.md)
  ## Excluded
`;

const LINE_TARGETS = `
LINE TARGETS (soft — stretch if the material warrants):
  _root files: ~300-400 lines
  zone files:  ~200-300 lines
Compress rather than pad. If a file would be <50 lines of real content, fold
that content into a sibling section elsewhere.
`;

function fileWritePolicy(memoryDir: string, worktree: string): string {
  return `
FILE WRITE POLICY (HARD)
------------------------
Your cwd (${worktree}) is a read-only checkout of origin/main, nested inside
the memory dir. Memory output lives in sibling directories of cwd, not in cwd.

You MAY write ONLY to these absolute paths:
    ${memoryDir}/_root/<file>.md
    ${memoryDir}/<zone>/<file>.md        (any declared zone)
    ${memoryDir}/.zones.json              (cold only; write once, before phase 2)

You MUST NOT write, edit, rm, mv, or git-mutate ANYTHING:
    inside cwd (${worktree})              — it is the repo, read-only
    at ${memoryDir}/.state.json           — the pipeline owns it
    at ${memoryDir}/.lock                 — the lock file

Any stray write — including via subagents, bash redirects, or git commands —
will cause this run to be discarded and the checkout hard-reset. No warning,
no recovery. Use absolute paths when writing memory files; do NOT cd out of
cwd and do NOT write to relative paths from cwd.
`;
}

const ENVIRONMENT = `
ENVIRONMENT
-----------
- cwd is a dedicated memory checkout (a fresh worktree of origin/main)
  nested inside the memory dir. Treat it as read-only reference material.
- All memory writes use absolute paths under the memory dir (see FILE
  WRITE POLICY). Never write relative to cwd.
- You have read, write, edit, bash, grep, find, subagent.
- Do NOT shell out to claude/cursor/aider/etc.
- Subagents are NOT allowed to read CLAUDE.md or AGENTS.md. You may read them yourself.
- Subagents inherit the same write policy. Tell them explicitly in the task prompt.
`;

const SUBAGENTS = `
SUBAGENTS AVAILABLE
-------------------
You have the 'subagent' tool. The only registered agent is 'codebase-explorer'
— a read-only agent that returns structured Finding / Evidence / Caveats
markdown. Dispatch many in one call:
    { "tasks": [
        { "agent": "codebase-explorer", "task": "<specific scoped question>" },
        ...
      ] }
Up to 5 tool call per batch. Pass only 'tasks'.
`;

// --- Cold ---

export function coldSystemPrompt(
  repo: string, memoryDir: string, worktree: string, manifest: string,
): string {
  return `You are the Memory agent for the "${repo}" repo — COLD START.

No prior memory exists. Your job has two phases:

PHASE 1 — DISCOVER ZONES
------------------------
Survey the repo and decide how (or whether) to carve it into zones.

A zone is a subtree that deserves its own dedicated memory because:
  - it has a distinct purpose (different runtime, different vocabulary, different team),
  - AND it contains a meaningful cluster of significant files.

Rules:
  - Zones are flat — no nested zones. If "apps/" contains "web" and "mobile",
    they are siblings (name: "web", path: "apps/web") not children of "apps".
  - Zone paths MUST be repo-relative prefixes (no leading or trailing slash).
  - Zone names MUST match /^[a-z0-9][a-z0-9-]*$/ and must not equal "_root".
  - Zones MUST NOT overlap. A file belongs to at most one zone.
  - Prefer FEWER, LARGER zones. Err toward putting a small subtree in _root.
  - A repo with no clear subdivision gets zero zones — that's fine.

Write the zone list to ${memoryDir}/.zones.json, exactly:
    { "zones": [
        { "name": "<slug>", "path": "<repo-relative-prefix>", "summary": "<one line>" },
        ...
      ] }
An empty array is valid. Write this file BEFORE starting Phase 2.

PHASE 2 — FILL MEMORY
---------------------
For _root and every zone you declared, produce the memory files below.

_root/ (5 files): ${ROOT_MEMORY_FILES.join(", ")}
Each zone (2 files): ${ZONE_MEMORY_FILES.join(", ")}

Suggested workflow:
  1. Orient: README.md, AGENTS.md, CLAUDE.md, package.json / pyproject.toml,
     entry file (e.g. src/index.ts). Treat doc claims as SEEDS to verify.
  2. Delegate: dispatch codebase-explorer subagents, scoped per zone plus
     any cross-cutting concerns. ONE tool call, many tasks.
  3. Synthesize: read findings, do targeted first-hand reads to confirm,
     then write all files.

Fan-out scales with repo size — a trivial repo may need no subagents at all;
a sprawling monorepo wants generous per-zone fan-out. Your call.

ANTI-PASTE RULE
---------------
Do NOT concatenate subagent findings into memory files. Every claim in a
memory file must be supported by >=2 evidence points from findings, OR by
a first-hand read you performed yourself.

${fileWritePolicy(memoryDir, worktree)}${CITATIONS}${ROOT_SECTIONS}${ZONE_SECTIONS}${LINE_TARGETS}${SUBAGENTS}${ENVIRONMENT}
FILE MANIFEST (format: "<path>\\t<line-count>", filtered for noise):
${manifest}

Write ${memoryDir}/.zones.json first, then all memory files under
${memoryDir}/${ROOT_DIR}/ and ${memoryDir}/<zone>/ for each declared zone.
Do NOT write ${memoryDir}/.state.json — the pipeline owns that file.
When done, end your output with "MEMORY_MAINTAINER_DONE".`;
}

export function coldInitialPrompt(repo: string, memoryDir: string): string {
  return `Cold start — no prior memory exists for "${repo}". Phase 1: discover zones and write ${memoryDir}/.zones.json. Phase 2: fill _root/ + every zone with the required files. Do not stop until every declared zone has both of its memory files.`;
}

// --- Warm ---

interface WarmMemorySnapshot {
  root: Partial<Record<string, string>>;
  zones: Array<{ zone: Zone; files: Partial<Record<string, string>> }>;
}

export function warmSystemPrompt(
  repo: string,
  memoryDir: string,
  worktree: string,
  zones: readonly Zone[],
  snapshot: WarmMemorySnapshot,
  changedByZone: Map<string, string[]>,
  unzonedHints: readonly string[],
): string {
  const rootBlock = ROOT_MEMORY_FILES
    .filter((n) => snapshot.root[n])
    .map((n) => `=== CURRENT _root/${n} ===\n${snapshot.root[n]!.trim()}\n=== END _root/${n} ===`)
    .join("\n\n");

  const zoneBlocks = snapshot.zones.map(({ zone, files }) => {
    const body = ZONE_MEMORY_FILES
      .filter((n) => files[n])
      .map((n) => `=== CURRENT ${zone.name}/${n} ===\n${files[n]!.trim()}\n=== END ${zone.name}/${n} ===`)
      .join("\n\n");
    return `--- ZONE: ${zone.name} (${zone.path}) ---\n${zone.summary}\n\n${body}`;
  }).join("\n\n");

  const diffBlock = [...changedByZone.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([name, files]) => `### ${name} (${files.length} changed)\n${files.join("\n")}`)
    .join("\n\n");

  const hintsBlock = unzonedHints.length > 0
    ? `\nUNZONED NEW SUBTREES DETECTED:\n${unzonedHints.join("\n")}\n\nAppend a note to _root/map.md's "Zone index" section flagging each for operator review. Example:\n    - new subtree \`services/billing/\` appeared; rebuild memory to evaluate as a zone.\n`
    : "";

  return `You are the Memory agent for the "${repo}" repo — WARM PATCH.

Memory already exists. Your job: patch markdown files so the memory reflects
recent code changes. You are PATCHING, not rebuilding.

STRUCTURAL INVARIANTS (hard)
----------------------------
- You MUST NOT create or delete any zone directories.
- You MUST NOT rename any zone.
- You MUST NOT modify ${memoryDir}/.state.json (the pipeline owns it).
- You MUST NOT modify ${memoryDir}/.zones.json (only cold rebuilds may).
If zone structure is wrong, do your best within the current structure and
flag the issue for the operator via _root/map.md (see below).

CURRENT ZONES (from .state.json):
${zones.length === 0 ? "(no zones — repo has only _root memory)" : zones.map((z) => `  - ${z.name} (${z.path}): ${z.summary}`).join("\n")}

CURRENT MEMORY (do not re-read from disk — this is the live content):
${rootBlock}

${zoneBlocks}

CHANGED FILES, BUCKETED BY ZONE:
${diffBlock || "(no changes detected — this is unexpected for a warm run; proceed minimally)"}
${hintsBlock}

DELETION IS AUTHORIZED AND EXPECTED
-----------------------------------
If a source file was deleted, remove references from the affected map.md.
If a pattern no longer has supporting code, remove the pattern. If a type
was removed, drop the glossary entry. Prune — memory that only grows decays.

${fileWritePolicy(memoryDir, worktree)}${CITATIONS}${ROOT_SECTIONS}${ZONE_SECTIONS}${LINE_TARGETS}${SUBAGENTS}${ENVIRONMENT}
Write patches only to files that need updating. Leave untouched files alone.
When done, end your output with "MEMORY_MAINTAINER_DONE".`;
}

export function warmInitialPrompt(repo: string, memoryDir: string): string {
  return `Warm patch — memory exists for "${repo}". Review the zones, current memory, and bucketed diff in the system prompt. Patch only the markdown files that need updating under ${memoryDir}/. Do not touch .state.json, .zones.json, or any zone directory structure.`;
}
```

**Commit:** `feat(pipelines/memory): cold + warm prompts with zone discovery + structural invariants`

---

## Task 6: Orchestrator (+ `runStage` postValidate hook)

**Files:**
- Create: `src/pipelines/memory/pipeline.ts`
- Modify: `src/core/stage.ts` (add `postValidate` hook)

### 6a. `runStage` postValidate hook

Add an optional hook to `RunStageOptions`:

```ts
export interface RunStageOptions {
  // ... existing fields ...
  /**
   * Runs after pi exits, before the stage row is marked complete and
   * before the terminal SSE emit. If it returns { valid: false }, the
   * stage is marked failed with the given reason and a single
   * `stage_update: failed` is emitted. Throws from postValidate bubble
   * up and are handled exactly like a pi-side failure.
   */
  postValidate?: () => Promise<{ valid: boolean; reason?: string }>;
}
```

In `runStage`'s success path, after pi exits cleanly but before emitting
`stage_update: complete`, call `postValidate` (if provided). On
`valid: false`, persist the stage row as `status: "failed"` with
`errorMessage: reason`, then emit exactly one `stage_update: failed`. Do
not emit `complete` first. This is the single atomic terminal emit the
dashboard sees.

### 6b. Memory pipeline

`src/pipelines/memory/pipeline.ts`:

```ts
/**
 * Memory pipeline. Orchestrates:
 *   1. Acquire atomic skip-on-contention lock. If held, mark "skipped".
 *   2. Ensure the dedicated memory worktree is present and clean at origin/main.
 *   3. Read .state.json. Missing/invalid or stored SHA unreachable -> COLD.
 *      Else compute git diff; empty -> fast path; else -> WARM.
 *   4. Run one pi stage (cold or warm) with cwd = memory worktree and a
 *      `postValidate` hook that enforces output contract + worktree cleanliness
 *      atomically with the stage's terminal status emit.
 *   5. On cold success: pipeline composes .state.json from .zones.json + HEAD sha.
 *      On warm success: pipeline rewrites .state.json with new sha (zones preserved).
 *   6. Always hard-reset the memory worktree in `finally`, even on failure.
 *   7. On throw: log; runStage already marked stage failed via postValidate.
 * Never propagates failure to caller.
 */

import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import * as queries from "../../db/queries.js";
import { emit } from "../../shared/events.js";
import {
  memoryDir, memoryWorktreeDir, rootMemoryDir, zoneMemoryDir,
  tryAcquireLock, releaseLock,
  ensureMemoryWorktree, assertMemoryWorktreeClean, resetMemoryWorktree,
  readState, writeState, readZonesSidecar,
  currentHeadSha, gitDiffFiles,
  buildFileManifest, readAllMemory,
  memoryFilesValid, stateFileHash,
  bucketPathsByZone, findUnzonedSubtrees,
  ROOT_DIR, ZONE_MEMORY_FILES, ROOT_MEMORY_FILES,
  type Zone,
} from "../../core/memory.js";
import {
  coldSystemPrompt, coldInitialPrompt,
  warmSystemPrompt, warmInitialPrompt,
} from "./prompts.js";
import { existsSync } from "node:fs";

const log = createLogger("memory-pipeline");
const COLD_TIMEOUT_MS = 20 * 60 * 1000;
const WARM_TIMEOUT_MS = 5 * 60 * 1000;

interface RunMemoryOptions {
  taskId: string;
  repo: string;
  repoPath: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

export async function runMemory(opts: RunMemoryOptions): Promise<void> {
  const { taskId, repo, repoPath, sendTelegram, chatId } = opts;

  try {
    const acquired = await tryAcquireLock(repo, taskId);
    if (!acquired) { await markSkipped(taskId, repo); return; }

    try {
      await mkdir(memoryDir(repo), { recursive: true });
      const worktree = await ensureMemoryWorktree(repo, repoPath);

      try {
        const headSha = await currentHeadSha(worktree);
        const state = await readState(repo);

        if (!state) {
          await runCold(opts, worktree, headSha);
          return;
        }

        const changed = await gitDiffFiles(worktree, state.lastIndexedSha, headSha);
        if (changed === null) {
          log.info(`Stored SHA ${state.lastIndexedSha.slice(0, 8)} unreachable; rebuilding cold for ${repo}`);
          await runCold(opts, worktree, headSha);
          return;
        }
        if (changed.length === 0) {
          log.info(`Memory up-to-date for ${repo} @ ${headSha.slice(0, 8)}`);
          await writeState(repo, headSha, state.zones);
          const stage = await queries.createTaskStage({ taskId, stage: "memory" });
          await queries.updateTaskStage(stage.id, { status: "complete", completedAt: new Date() });
          emit({ type: "stage_update", taskId, stage: "memory", status: "complete" });
          return;
        }

        await runWarm(opts, worktree, state, changed, headSha);
      } finally {
        // Always reset the worktree — even on success. It's a view, not storage.
        await resetMemoryWorktree(repo);
      }
    } finally {
      await releaseLock(repo);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Memory stage failed for task ${taskId} repo ${repo}: ${message}`);
  }
}

// --- Cold ---

async function runCold(
  opts: RunMemoryOptions, worktree: string, headSha: string,
): Promise<void> {
  const cap = subagentCapability();
  const manifest = await buildFileManifest(worktree);
  let validatedZones: readonly Zone[] | null = null;

  await runStage({
    taskId: opts.taskId,
    stage: "memory",
    cwd: worktree,
    systemPrompt: coldSystemPrompt(opts.repo, memoryDir(opts.repo), worktree, manifest),
    initialPrompt: coldInitialPrompt(opts.repo, memoryDir(opts.repo)),
    model: modelForMemory(),
    sendTelegram: opts.sendTelegram,
    chatId: opts.chatId,
    stageLabel: "Memory (cold)",
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
    timeoutMs: COLD_TIMEOUT_MS,
    postValidate: async () => {
      const zones = await readZonesSidecar(opts.repo);
      if (zones === null) return { valid: false, reason: ".zones.json missing or invalid" };
      const fileCheck = memoryFilesValid(opts.repo, zones);
      if (!fileCheck.valid) return { valid: false, reason: fileCheck.reason };
      const clean = await assertMemoryWorktreeClean(opts.repo);
      if (!clean.clean) {
        return { valid: false, reason: `memory worktree dirty after cold: ${clean.dirty.slice(0, 5).join(", ")}` };
      }
      validatedZones = zones;
      return { valid: true };
    },
  });

  if (validatedZones) await writeState(opts.repo, headSha, validatedZones);
}

// --- Warm ---

async function runWarm(
  opts: RunMemoryOptions,
  worktree: string,
  state: NonNullable<Awaited<ReturnType<typeof readState>>>,
  changedFiles: readonly string[],
  headSha: string,
): Promise<void> {
  const cap = subagentCapability();
  const snapshot = await readAllMemory(opts.repo, state.zones);
  const bucketed = bucketPathsByZone(changedFiles, state.zones);
  const hints = findUnzonedSubtrees(changedFiles, state.zones);
  const stateHashBefore = await stateFileHash(opts.repo);
  const zoneDirsBefore = await listZoneDirs(opts.repo);
  let structurallyValid = false;

  await runStage({
    taskId: opts.taskId,
    stage: "memory",
    cwd: worktree,
    systemPrompt: warmSystemPrompt(
      opts.repo, memoryDir(opts.repo), worktree,
      state.zones, snapshot, bucketed, hints,
    ),
    initialPrompt: warmInitialPrompt(opts.repo, memoryDir(opts.repo)),
    model: modelForMemory(),
    sendTelegram: opts.sendTelegram,
    chatId: opts.chatId,
    stageLabel: "Memory (warm)",
    extensions: cap.extensions,
    envOverrides: cap.envOverrides,
    timeoutMs: WARM_TIMEOUT_MS,
    postValidate: async () => {
      const stateHashAfter = await stateFileHash(opts.repo);
      if (stateHashBefore !== stateHashAfter) {
        return { valid: false, reason: "warm illegally modified .state.json" };
      }
      const zoneDirsAfter = await listZoneDirs(opts.repo);
      const added = zoneDirsAfter.filter((d) => !zoneDirsBefore.includes(d));
      if (added.length > 0) {
        return { valid: false, reason: `warm created unauthorized zones: ${added.join(", ")}` };
      }
      const fileCheck = memoryFilesValid(opts.repo, state.zones);
      if (!fileCheck.valid) return { valid: false, reason: fileCheck.reason };
      const clean = await assertMemoryWorktreeClean(opts.repo);
      if (!clean.clean) {
        return { valid: false, reason: `memory worktree dirty after warm: ${clean.dirty.slice(0, 5).join(", ")}` };
      }
      structurallyValid = true;
      return { valid: true };
    },
  });

  if (structurallyValid) await writeState(opts.repo, headSha, state.zones);
}

// --- Helpers ---

async function listZoneDirs(repo: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir(repo), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== ROOT_DIR && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

async function markSkipped(taskId: string, repo: string): Promise<void> {
  log.info(`Memory lock held for ${repo}; skipping for task ${taskId}`);
  const stage = await queries.createTaskStage({ taskId, stage: "memory" });
  await queries.updateTaskStage(stage.id, { status: "skipped", completedAt: new Date() });
  emit({ type: "stage_update", taskId, stage: "memory", status: "skipped" });
}

function modelForMemory(): string {
  const env = loadEnv();
  return env.PI_MODEL_MEMORY ?? env.PI_MODEL;
}
```

**Commits (two, in this order):**
1. `feat(core/stage): add postValidate hook for atomic terminal status`
2. `feat(pipelines/memory): orchestrator with dedicated worktree, zone-aware cold/warm, postValidate integrity checks`

---

## Task 7: `memoryBlock(repo)` — unconditional injection

**Files:**
- Modify: `src/shared/agent-prompts.ts`

```ts
import {
  readState, readAllMemory,
  ROOT_MEMORY_FILES, ZONE_MEMORY_FILES, ROOT_DIR,
} from "../core/memory.js";

/**
 * Render every memory file (_root + every zone) for downstream stages.
 * No scoping — all memory is injected unconditionally. Returns empty string
 * when no memory exists.
 */
export async function memoryBlock(repo: string): Promise<string> {
  const state = await readState(repo);
  if (!state) return "";

  const { root, zones } = await readAllMemory(repo, state.zones);
  const rootBody = ROOT_MEMORY_FILES
    .filter((n) => root[n])
    .map((n) => `=== MEMORY ${ROOT_DIR}/${n} ===\n${root[n]!.trim()}\n=== END ${ROOT_DIR}/${n} ===`)
    .join("\n\n");

  const zoneBody = zones.map(({ zone, files }) => {
    const header = `--- ZONE: ${zone.name} (${zone.path}) — ${zone.summary} ---`;
    const body = ZONE_MEMORY_FILES
      .filter((n) => files[n])
      .map((n) => `=== MEMORY ${zone.name}/${n} ===\n${files[n]!.trim()}\n=== END ${zone.name}/${n} ===`)
      .join("\n\n");
    return `${header}\n${body}`;
  }).join("\n\n");

  if (!rootBody && !zoneBody) return "";

  return `
CODEBASE MEMORY:
Agent-maintained knowledge base for this repo. Every factual claim cites the
source file it was drawn from. Trust this as context, but prefer a direct
file read if a claim contradicts what you see in code.

${rootBody}

${zoneBody}
`;
}
```

**Commit:** `feat(shared): memoryBlock injects full memory tree (root + every zone)`

---

## Task 8: Wire into coding pipeline

**Files:**
- Modify: `src/pipelines/coding/pipeline.ts`
- Modify: `src/pipelines/coding/prompts.ts`

In `coding/pipeline.ts`, after `syncRepo`, before `generateBranchName`:

```ts
import { runMemory } from "../memory/pipeline.js";

await runMemory({
  taskId, repo: task.repo, repoPath: repo.localPath, sendTelegram, chatId,
});
// Soft-fail; never throws.
```

In `coding/prompts.ts`, make `plannerPrompt`, `implementerPrompt`, `reviewerPrompt` async, add `repo: string` parameter, prepend `await memoryBlock(repo)`. Thread `task.repo` through the coding pipeline's prompt builders.

**Verify:**
- `npm run build` clean.
- Kick a coding task. Dashboard shows `memory` first, then planner/implementer/reviewer. `artifacts/memory-<INSTANCE>-<repo>/` contains `_root/` + any zones + `.state.json` + `.zones.json`.

**Commit:** `feat(coding): run memory and inject memory into stage prompts`

---

## Task 9: Wire into question pipeline

**Files:**
- Modify: `src/pipelines/question/pipeline.ts`
- Modify: `src/pipelines/question/prompts.ts`

Same pattern as Task 8: call `runMemory` after `syncRepo`; make `questionSystemPrompt` async, accept `repo`, prepend `await memoryBlock(repo)`.

**Commit:** `feat(question): run memory and inject memory into answering prompt`

---

## Task 10: pr-session revision + pr-review stub

**Files:**
- Modify: revision prompt builder under `src/pipelines/pr-session/`
- Modify: `src/pipelines/pr-review/pipeline.ts`

Prepend `await memoryBlock(repo)` to the revision prompt only. Do NOT inject into any `pr_creator` prompt.

In `pr-review/pipeline.ts` (stubbed):

```ts
// TODO when pr-review is implemented:
// after syncRepo, before createPrWorktree:
//   await runMemory({ taskId, repo: task.repo, repoPath: repo.localPath, sendTelegram, chatId });
```

**Commit:** `feat(pr-session): inject memory into revision prompts; pr-review TODO`

---

## Task 11: `GET /api/memory/:repo`

**Files:**
- Modify: `src/api/index.ts`

```ts
import { memoryStatus, currentHeadSha } from "../core/memory.js";
import { getRepo } from "../shared/repos.js";

app.get("/api/memory/:repo", async (c) => {
  const name = c.req.param("repo");
  const repo = getRepo(name);
  if (!repo) return c.json({ error: "unknown repo" }, 404);

  const { state, fileCount, totalBytes } = await memoryStatus(name);
  if (!state) {
    return c.json({
      repo: name, status: "missing",
      lastIndexedSha: null, lastIndexedAt: null,
      fileCount: 0, totalBytes: 0, zones: [],
    });
  }

  let live: string | null = null;
  try { live = await currentHeadSha(repo.localPath); } catch { /* unreachable */ }

  return c.json({
    repo: name,
    status: live && live === state.lastIndexedSha ? "fresh" : "stale",
    lastIndexedSha: state.lastIndexedSha,
    lastIndexedAt: state.lastIndexedAt,
    fileCount, totalBytes,
    zones: state.zones.map((z) => ({ name: z.name, path: z.path, summary: z.summary })),
  });
});
```

**Commit:** `feat(api): GET /api/memory/:repo (includes zones)`

---

## Task 12: Dashboard — memory block on Repos page

**Files:**
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/components/rows/RepoRow.tsx`

In `api.ts`:

```ts
export interface MemoryZone {
  name: string; path: string; summary: string;
}
export interface MemoryStatus {
  repo: string;
  status: "fresh" | "stale" | "missing";
  lastIndexedSha: string | null;
  lastIndexedAt: string | null;
  fileCount: number;
  totalBytes: number;
  zones: MemoryZone[];
}
export async function fetchMemoryStatus(repo: string): Promise<MemoryStatus> {
  const res = await fetch(`/api/memory/${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`Failed to load memory status for ${repo}`);
  return res.json();
}
```

In `RepoRow.tsx`, render a block that shows status pill, sha, age, file count, and a one-liner per zone (name + path). Micro-scale mono text per house style.

**Commit:** `feat(dashboard): memory status block on Repos page (with zones)`

---

## Task 13: Orphan warning at startup

**Files:**
- Modify: `src/index.ts`
- Modify: `src/observability/index.ts` if no single-event emitter exists

If observability lacks a one-shot emitter:

```ts
import { getTracer } from "./tracer.js";

export function emitStartupEvent(name: string, attrs: Record<string, string | number>): void {
  const span = getTracer().startSpan(name);
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  span.end();
}
```

Because the memory worktree is nested inside the memory dir, a single
scan of `artifacts/` covers everything. `findOrphanedMemoryDirs` stays
single-kind. Additionally, at startup we prune each REGISTERED repo's
worktree registry so entries pointing at deleted memory checkouts get
cleaned up.

In `src/index.ts`, after env load, before listen:

```ts
import { findOrphanedMemoryDirs } from "./core/memory.js";
import { listRepos, listRepoNames } from "./shared/repos.js";
import { emitStartupEvent } from "./observability/index.js";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);

// Sweep stale worktree registry entries across all registered repos.
for (const repo of listRepos()) {
  try { await exec("git", ["worktree", "prune"], { cwd: repo.localPath }); }
  catch (err) { log.warn(`git worktree prune failed in ${repo.localPath}`, err); }
}

const orphans = await findOrphanedMemoryDirs(listRepoNames());
for (const o of orphans) {
  log.warn(
    `Orphaned memory directory: ${o.path} (repo "${o.repo}" not in REGISTERED_REPOS). Leaving on disk.`,
  );
  emitStartupEvent("goodboy.memory.orphan_detected", {
    "goodboy.memory.repo": o.repo,
    "goodboy.memory.path": o.path,
  });
}
```

**Commit:** `feat(startup): prune stale worktree registries, warn on orphaned memory dirs, emit Logfire event`

---

## Task 14: E2E verification

1. Wipe memory: `rm -rf artifacts/memory-*-coliseum`.
2. Submit a question via Telegram: `"what's the architecture of coliseum?"`.
3. Observe:
   - `memory` stage runs, completes cold.
   - `.zones.json` and `.state.json` both present; zones array reflects the agent's judgment (coliseum is small — likely `zones: []`).
   - `_root/` contains all 5 files; every declared zone contains both files.
   - Every claim cites `[path:line]`; section headers match contract.
   - `answering` stage references memory claims.
   - `/repos` shows memory block with status, sha, age, zone count.
4. Submit a second task immediately. Second `memory` shows `skipped`.
5. Make a trivial commit, push. Submit a task. Observe warm run; `.zones.json` untouched; `.state.json` SHA advances.
6. Force-push rebased main. Submit a task. Observe cold rebuild (unreachable SHA → cold).
7. Run against a genuine monorepo (e.g. register one with clearly distinct subtrees). Confirm cold carves reasonable zones, warm patches only affected zones' files.
8. Negative test (state tamper): manually edit `artifacts/memory-*-coliseum/.state.json` mid-task to simulate warm modifying it. Confirm `postValidate` fires, stage emits exactly one `failed` (no prior `complete`), and the worktree is reset.
9. Negative test (worktree write): add a sentinel write to the system prompt and confirm any write inside `artifacts/memory-*-coliseum/checkout/` is caught by `assertMemoryWorktreeClean`, stage fails, worktree is reset.

**Commit:** verification only; fix-forwards use `fix:` prefix.

---


## Task 15: Manual test runners for cold + warm

**Files:**
- Create: `tests/scripts/run-memory-cold.ts`
- Create: `tests/scripts/run-memory-warm.ts`
- Modify: `package.json` (two new script entries)

These are not vitest tests. They are standalone `tsx`-runnable CLI scripts for manually exercising the memory pipeline end-to-end in a fully isolated test instance. They live in `tests/scripts/` to stay out of the vitest discovery tree (vitest only scans `tests/unit/**` and `tests/integration/**`).

### Naming convention

The generated instance ID is always `TEST-<8 hex chars>`. The resulting memory dir becomes `artifacts/memory-TEST-<hex>-<repo>/`. The `TEST-` prefix makes these trivially distinguishable from production memory — easy to spot in logs, easy to clean with `rm -rf artifacts/memory-TEST-*`, and intentionally flagged as orphans by the startup scanner (since `INSTANCE_ID` in production will never start with `TEST-`).

---

### `tests/scripts/run-memory-cold.ts`

Accepts two positional CLI arguments:
1. `<test-memory>` — a label for this test run (used only for log output; lets the operator tag multiple parallel test runs).
2. `<repo-name>` — a repo slug registered in `REGISTERED_REPOS` (e.g. `goodboy`).

Behaviour:
1. Load `.env` (via `dotenv`).
2. Generate instance ID: `TEST-${randomBytes(4).toString("hex")}`.
3. Override `process.env.INSTANCE_ID` with the generated ID **before** importing anything that calls `loadEnv()`.
4. Resolve `repoPath` from the repo's `localPath` in `shared/repos.ts`.
5. Call `runMemory({ taskId: "<test-memory>-cold", repo, repoPath, sendTelegram: noopTelegram, chatId: null })`.
6. On completion, print the instance ID, memory dir path, `.state.json` content, and zone count so the warm script can be invoked immediately.
7. Exit non-zero on any uncaught error.

```ts
/**
 * Manual cold-start test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-cold.ts <test-label> <repo-name>
 *
 * Generates a TEST-prefixed instance ID so artifacts are clearly isolated
 * from production memory. Prints the instance ID at the end for use with
 * run-memory-warm.ts.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const [, , testLabel, repoName] = process.argv;
if (!testLabel || !repoName) {
  console.error("Usage: npx tsx tests/scripts/run-memory-cold.ts <test-label> <repo-name>");
  process.exit(1);
}

// Set BEFORE any loadEnv() call so the generated ID is picked up everywhere.
const instanceId = `TEST-${randomBytes(4).toString("hex")}`;
process.env["INSTANCE_ID"] = instanceId;

// Dynamic imports so the env override lands first.
const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath } = await import("../../src/core/memory.js");

const repo = getRepo(repoName);
if (!repo) {
  console.error(`Unknown repo: ${repoName}. Check REGISTERED_REPOS.`);
  process.exit(1);
}

const noopTelegram = async () => {};

console.log(`\n=== MEMORY COLD-START TEST ===`);
console.log(`label      : ${testLabel}`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`\nRunning cold memory stage...\n`);

await runMemory({
  taskId: `${testLabel}-cold`,
  repo: repoName,
  repoPath: repo.localPath,
  sendTelegram: noopTelegram,
  chatId: null,
});

try {
  const state = JSON.parse(await readFile(memoryStatePath(repoName), "utf8"));
  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${state.zones?.length ?? 0}`);
  console.log(`sha        : ${state.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${state.lastIndexedAt}`);
} catch {
  console.error(`No .state.json found — cold run may have failed.`);
}

console.log(`\nTo test warm, run:`);
console.log(`  npm run test:memory:warm -- ${testLabel} ${repoName} ${instanceId}\n`);
```

---

### `tests/scripts/run-memory-warm.ts`

Accepts three positional CLI arguments:
1. `<test-memory>` — same label used in the cold run.
2. `<repo-name>` — same repo slug.
3. `<instance-id>` — the `TEST-<hex>` value printed by the cold runner.

Behaviour:
1. Load `.env`.
2. Validate `<instance-id>` starts with `TEST-`; exit early with a clear error if not.
3. Set `process.env.INSTANCE_ID` to the provided `<instance-id>`.
4. Read the existing `.state.json` to confirm cold memory is present; exit early with a helpful copy-paste message if missing.
5. Snapshot `.zones.json` hash before the run.
6. Call `runMemory({ taskId: "<test-memory>-warm", repo, repoPath, sendTelegram: noopTelegram, chatId: null })`.
7. After completion, compare `.state.json` SHA before/after and compare `.zones.json` hash (must be identical — warm is forbidden from touching it).

```ts
/**
 * Manual warm-patch test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-warm.ts <test-label> <repo-name> <TEST-instance-id>
 *
 * Reuses the memory directory created by run-memory-cold.ts. The instance ID
 * must be the TEST-prefixed value printed by the cold runner.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [, , testLabel, repoName, instanceId] = process.argv;
if (!testLabel || !repoName || !instanceId) {
  console.error(
    "Usage: npx tsx tests/scripts/run-memory-warm.ts <test-label> <repo-name> <TEST-instance-id>",
  );
  process.exit(1);
}
if (!instanceId.startsWith("TEST-")) {
  console.error(`instance-id must start with TEST-. Got: ${instanceId}`);
  process.exit(1);
}

process.env["INSTANCE_ID"] = instanceId;

const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath, zonesSidecarPath } = await import("../../src/core/memory.js");

const repo = getRepo(repoName);
if (!repo) {
  console.error(`Unknown repo: ${repoName}. Check REGISTERED_REPOS.`);
  process.exit(1);
}

const statePath = memoryStatePath(repoName);
let stateBefore: string;
try {
  stateBefore = await readFile(statePath, "utf8");
} catch {
  console.error(
    `No .state.json found at ${statePath}.\nRun the cold script first:\n  npm run test:memory:cold -- ${testLabel} ${repoName}`,
  );
  process.exit(1);
}

const zonesPath = zonesSidecarPath(repoName);
const zonesHashBefore = await readFile(zonesPath, "utf8")
  .then((c) => createHash("sha256").update(c).digest("hex"))
  .catch(() => null);

const parsedBefore = JSON.parse(stateBefore);

console.log(`\n=== MEMORY WARM-PATCH TEST ===`);
console.log(`label      : ${testLabel}`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`sha-before : ${parsedBefore.lastIndexedSha?.slice(0, 12)}`);
console.log(`\nRunning warm memory stage...\n`);

const noopTelegram = async () => {};
await runMemory({
  taskId: `${testLabel}-warm`,
  repo: repoName,
  repoPath: repo.localPath,
  sendTelegram: noopTelegram,
  chatId: null,
});

try {
  const stateAfter = await readFile(statePath, "utf8");
  const parsedAfter = JSON.parse(stateAfter);
  const zonesHashAfter = await readFile(zonesPath, "utf8")
    .then((c) => createHash("sha256").update(c).digest("hex"))
    .catch(() => null);

  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${parsedAfter.zones?.length ?? 0}`);
  console.log(`sha-before : ${parsedBefore.lastIndexedSha?.slice(0, 12)}`);
  console.log(`sha-after  : ${parsedAfter.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${parsedAfter.lastIndexedAt}`);
  console.log(
    `.zones.json: ${zonesHashBefore === zonesHashAfter ? "untouched (correct)" : "MODIFIED — invariant violation"}`,
  );
} catch {
  console.error(`Could not read .state.json after warm run — warm run may have failed.`);
}
```

---

### `package.json` additions

```json
"test:memory:cold": "tsx tests/scripts/run-memory-cold.ts",
"test:memory:warm":  "tsx tests/scripts/run-memory-warm.ts"
```

Invoked as:

```bash
# Cold — generates a fresh TEST-<hex> instance ID and prints it.
npm run test:memory:cold -- my-test goodboy

# Warm — pass the exact instance ID printed by the cold run.
npm run test:memory:warm -- my-test goodboy TEST-a1b2c3d4
```

The cold script always outputs the complete `npm run test:memory:warm` invocation as a copy-pasteable line, so the operator never has to transcribe the hex ID by hand.

---

**Verify:**
- `npm run build` clean (scripts are `tsx`-only; tsc does not type-check `tests/scripts/`, but imports from `src/` must resolve).
- Run cold against a registered repo; confirm `artifacts/memory-TEST-*-<repo>/` is created with valid `.state.json`.
- Run warm with the printed instance ID; confirm `.zones.json` hash is unchanged, and `.state.json` SHA advances (or matches HEAD if no new commits have landed — fast-path still rewrites the file).
- Confirm that on the next production server start, the `TEST-` dirs appear in the orphan warning log (expected and intentional — clean them with `rm -rf artifacts/memory-TEST-*`).

**Commit:** `feat(tests): manual cold + warm memory test runners with TEST-prefixed isolation`

---

## Post-plan checklist

- [ ] Task 2 migration applied from laptop (`npm run db:migrate`)
- [ ] `.env.example` carries `PI_MODEL_MEMORY=`
- [ ] `npm run build` clean
- [ ] `/repos` renders memory block with zones
- [ ] Orphan warning fires in logs + Logfire
- [ ] Cold + warm + skip + force-push-rebuild observed at least once each
- [ ] Post-run validation (via `postValidate`) triggers at least once in staging and emits a single atomic `failed` status
- [ ] Memory checkout exists under `artifacts/memory-<INSTANCE>-<repo>/checkout/` and is reset clean between runs (confirm via `git status --porcelain`)
- [ ] Stray-write negative test triggers `assertMemoryWorktreeClean` and fails the stage
- [ ] Orphan scan flags orphaned memory dirs; startup prunes stale worktree registry entries
- [ ] Monorepo carved into >=2 zones by cold; warm patches localize to affected zones only
