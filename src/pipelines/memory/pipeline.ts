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
import { createLogger } from "../../shared/logger.js";
import { loadEnv } from "../../shared/config.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { runStage, type SendTelegram } from "../../core/stage.js";
import { taskSessionPath } from "../../core/pi/session-file.js";
import * as queries from "../../db/repository.js";
import { emit } from "../../shared/events.js";
import {
  memoryDir,
  tryAcquireLock, releaseLock,
  ensureMemoryWorktree, assertMemoryWorktreeClean, resetMemoryWorktree,
  readState, writeState, readZonesSidecar,
  currentHeadSha, gitDiffFiles,
  buildFileManifest, readAllMemory,
  memoryFilesValid, stateFileHash,
  bucketPathsByZone, findUnzonedSubtrees,
  ROOT_DIR,
  type Zone, type MemoryState,
} from "../../core/memory.js";
import {
  coldSystemPrompt, coldInitialPrompt,
  warmSystemPrompt, warmInitialPrompt,
} from "./prompts.js";

const log = createLogger("memory-pipeline");

const COLD_TIMEOUT_MS = 20 * 60 * 1000;
const WARM_TIMEOUT_MS = 5 * 60 * 1000;

// --- Public API ---

type MemoryRunSource = "task" | "manual_test";
type MemoryRunKind = "cold" | "warm" | "skip" | "noop";

interface RunMemoryOptions {
  taskId: string;
  repo: string;
  repoPath: string;
  source?: MemoryRunSource;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/** Run the memory stage for a task. Soft-fail: never throws to the caller. */
export async function runMemory(opts: RunMemoryOptions): Promise<void> {
  const { taskId, repo, repoPath } = opts;

  try {
    const acquired = await tryAcquireLock(repo, taskId);
    if (!acquired) { await markSkipped(opts); return; }

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
          const stage = await createBestEffortMemoryStage(taskId);
          if (stage) {
            await queries.updateTaskStage(stage.id, { status: "complete", completedAt: new Date() });
          }
          await recordMemoryRunComplete(opts, "noop", {
            sha: headSha,
            zoneCount: state.zones.length,
          });
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
  const sessionPath = taskSessionPath(opts.taskId, "memory");
  const runId = await createMemoryRunRecord(opts, "cold", sessionPath);
  let validatedZones: readonly Zone[] | null = null;

  try {
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
  } catch (err) {
    await failMemoryRunRecord(runId, err);
    throw err;
  }

  if (!validatedZones) {
    await failMemoryRunRecord(runId, "cold validation failed");
    return;
  }

  const zones: readonly Zone[] = validatedZones;
  await writeState(opts.repo, headSha, zones);
  await completeMemoryRunRecord(runId, {
    sha: headSha,
    zoneCount: zones.length,
  });
}

// --- Warm ---

async function runWarm(
  opts: RunMemoryOptions,
  worktree: string,
  state: MemoryState,
  changedFiles: readonly string[],
  headSha: string,
): Promise<void> {
  const cap = subagentCapability();
  const snapshot = await readAllMemory(opts.repo, state.zones);
  const bucketed = bucketPathsByZone(changedFiles, state.zones);
  const hints = findUnzonedSubtrees(changedFiles, state.zones);
  const stateHashBefore = await stateFileHash(opts.repo);
  const zoneDirsBefore = await listZoneDirs(opts.repo);
  const sessionPath = taskSessionPath(opts.taskId, "memory");
  const runId = await createMemoryRunRecord(opts, "warm", sessionPath);
  let structurallyValid = false;

  try {
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
  } catch (err) {
    await failMemoryRunRecord(runId, err);
    throw err;
  }

  if (!structurallyValid) {
    await failMemoryRunRecord(runId, "warm validation failed");
    return;
  }

  await writeState(opts.repo, headSha, state.zones);
  await completeMemoryRunRecord(runId, {
    sha: headSha,
    zoneCount: state.zones.length,
  });
}

// --- Helpers ---

async function listZoneDirs(repo: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir(repo), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== ROOT_DIR && e.name !== "checkout" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

async function markSkipped(opts: RunMemoryOptions): Promise<void> {
  log.info(`Memory lock held for ${opts.repo}; skipping for task ${opts.taskId}`);
  const stage = await createBestEffortMemoryStage(opts.taskId);
  if (stage) {
    await queries.updateTaskStage(stage.id, { status: "skipped", completedAt: new Date() });
  }
  await recordMemoryRunComplete(opts, "skip");
  emit({ type: "stage_update", taskId: opts.taskId, stage: "memory", status: "skipped" });
}

async function createBestEffortMemoryStage(taskId: string) {
  return queries.createTaskStage({ taskId, stage: "memory" }).catch(() => null);
}

async function createMemoryRunRecord(
  opts: RunMemoryOptions,
  kind: MemoryRunKind,
  sessionPath: string | null,
): Promise<string | null> {
  try {
    const run = await queries.createMemoryRun({
      instance: loadEnv().INSTANCE_ID,
      repo: opts.repo,
      kind,
      sessionPath,
      ...memoryRunIdentity(opts),
    });
    return run.id;
  } catch (err) {
    log.warn(`Failed to create memory_runs row for ${opts.repo}`, err);
    return null;
  }
}

async function completeMemoryRunRecord(
  runId: string | null,
  data: { sha?: string; zoneCount?: number } = {},
): Promise<void> {
  if (!runId) return;
  try {
    await queries.updateMemoryRun(runId, {
      status: "complete",
      sha: data.sha ?? null,
      zoneCount: data.zoneCount ?? null,
      completedAt: new Date(),
    });
  } catch (err) {
    log.warn(`Failed to complete memory_runs row ${runId}`, err);
  }
}

async function failMemoryRunRecord(runId: string | null, err: unknown): Promise<void> {
  if (!runId) return;
  const error = err instanceof Error ? err.message : String(err);
  try {
    await queries.updateMemoryRun(runId, {
      status: "failed",
      error,
      completedAt: new Date(),
    });
  } catch (updateErr) {
    log.warn(`Failed to fail memory_runs row ${runId}`, updateErr);
  }
}

async function recordMemoryRunComplete(
  opts: RunMemoryOptions,
  kind: MemoryRunKind,
  data: { sha?: string; zoneCount?: number } = {},
): Promise<void> {
  const runId = await createMemoryRunRecord(opts, kind, null);
  await completeMemoryRunRecord(runId, data);
}

function memoryRunIdentity(opts: RunMemoryOptions) {
  const source = opts.source ?? inferRunSource();
  return source === "task"
    ? { source: "task" as const, originTaskId: opts.taskId, externalLabel: null }
    : { source: "manual_test" as const, originTaskId: null, externalLabel: opts.taskId };
}

function inferRunSource(): MemoryRunSource {
  return loadEnv().INSTANCE_ID.startsWith("TEST-") ? "manual_test" : "task";
}

function modelForMemory(): string {
  const env = loadEnv();
  return env.PI_MODEL_MEMORY ?? env.PI_MODEL;
}
