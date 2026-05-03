/**
 * Memory pipeline. Resource lifecycle (lock + worktree) is owned by
 * `withMemoryRun`; this file only decides which run kind applies.
 *
 *   withMemoryRun -> body(worktree) runs unless the lock is held.
 *     read .state.json.
 *       missing / invalid / sha unreachable -> runCold
 *       git diff empty                       -> noop (rewrite state, finalize)
 *       otherwise                            -> runWarm
 *   withMemoryRun returned "lock_held" -> record a skip run and finalize.
 *
 * Cold/warm spawn a pi stage with a `postValidate` hook that enforces the
 * output contract + worktree cleanliness. runStage returns `{ok}` and we
 * branch on it; pi-side throws propagate and are caught by the outer catch.
 * Cold success composes .state.json from .zones.json + HEAD sha; warm
 * success rewrites .state.json with new sha (zones preserved).
 *
 * Every memory run -- including skip and noop -- flows through a
 * `MemoryRunTracker` for the `memory_runs` row + SSE emits. The `task_stages`
 * row is owned by `runStage` for cold/warm and by `finalizeInlineMemoryStage`
 * for skip/noop (the two paths that don't spawn a pi session).
 *
 * Never propagates failure to caller.
 */


import { trace, type Span } from "@opentelemetry/api";
import { createLogger } from "../../shared/runtime/logger.js";
import { resolveModel } from "../../shared/runtime/config.js";
import type { MemoryRunSource, StageStatus } from "../../shared/domain/types.js";
import { subagentCapability } from "../../core/subagents/index.js";
import { runStage, isPersistedTaskId, type SendTelegram, type StageValidation } from "../../core/stage.js";
import { taskSessionPath } from "../../core/pi/session-file.js";
import * as queries from "../../db/repository.js";
import { emit } from "../../shared/runtime/events.js";
import { withPipelineSpan } from "../../observability/index.js";
import { Goodboy } from "../../observability/attributes.js";
import {
  memoryDir, withMemoryRun,
  readState, writeState,
  currentHeadSha, gitDiffFiles,
  buildFileManifest, readAllMemory,
  stateFileHash, listZoneDirs,
  bucketPathsByZone, findUnzonedSubtrees,
  type Zone, type MemoryState,
} from "../../core/memory/index.js";
import { validateColdOutput, validateWarmOutput } from "../../core/memory/output/validate.js";
import { ensureCodeReviewerFeedbackFile } from "../../core/memory/feedback/code-reviewer-feedback.js";
import { startMemoryRun, type MemoryRunTracker } from "../../core/memory/lifecycle/run-tracker.js";
import {
  coldSystemPrompt, coldInitialPrompt,
  warmSystemPrompt, warmInitialPrompt,
} from "./prompts.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";

const log = createLogger("memory-pipeline");

const COLD_TIMEOUT_MS = 20 * 60 * 1000;
const WARM_TIMEOUT_MS = 5 * 60 * 1000;

// --- Public API ---

interface RunMemoryOptions {
  taskId: string;
  repo: string;
  repoPath: string;
  source: MemoryRunSource;
  sendTelegram: SendTelegram;
  chatId: string | null;
}

/** Run the memory stage for a task. Soft-fail: never throws to the caller. */
export async function runMemory(opts: RunMemoryOptions): Promise<void> {
  return withPipelineSpan(
    { taskId: opts.taskId, kind: "memory", repo: opts.repo },
    async (pipelineSpan) => {
      pipelineSpan.setAttribute(Goodboy.MemorySource, opts.source);
      await runMemoryInner(opts, pipelineSpan);
    },
  );
}

async function runMemoryInner(opts: RunMemoryOptions, pipelineSpan: Span): Promise<void> {
  const { taskId, repo, repoPath } = opts;

  try {
    await ensureCodeReviewerFeedbackFile(repo);

    const outcome = await withMemoryRun(repo, repoPath, taskId, async (worktree) => {
      const headSha = await currentHeadSha(worktree);
      pipelineSpan.setAttribute(Goodboy.MemorySha, headSha);
      const state = await readState(repo);

      if (!state) {
        pipelineSpan.setAttribute(Goodboy.MemoryKind, "cold");
        await runCold(opts, worktree, headSha);
        return;
      }

      const changed = await gitDiffFiles(worktree, state.lastIndexedSha, headSha);
      if (changed === null) {
        pipelineSpan.setAttribute(Goodboy.MemoryKind, "cold");
        pipelineSpan.setAttribute(Goodboy.MemorySkipReason, "sha_unreachable");
        log.info(`Stored SHA ${state.lastIndexedSha.slice(0, 8)} unreachable; rebuilding cold for ${repo}`);
        await runCold(opts, worktree, headSha);
        return;
      }
      if (changed.length === 0) {
        pipelineSpan.setAttribute(Goodboy.MemoryKind, "noop");
        pipelineSpan.setAttribute(Goodboy.MemoryZoneCount, state.zones.length);
        log.info(`Memory up-to-date for ${repo} @ ${headSha.slice(0, 8)}`);
        await writeState(repo, headSha, state.zones);
        const tracker = await startMemoryRun({ ...opts, kind: "noop", sessionPath: null });
        await tracker.complete({ sha: headSha, zoneCount: state.zones.length });
        await finalizeInlineMemoryStage(taskId, "complete");
        return;
      }

      pipelineSpan.setAttribute(Goodboy.MemoryKind, "warm");
      pipelineSpan.setAttribute(Goodboy.MemoryChangedFiles, changed.length);
      pipelineSpan.setAttribute(Goodboy.MemoryZoneCount, state.zones.length);
      await runWarm(opts, worktree, state, changed, headSha);
    });

    if (outcome === "lock_held") {
      pipelineSpan.setAttribute(Goodboy.MemoryKind, "skip");
      pipelineSpan.setAttribute(Goodboy.MemorySkipReason, "lock_held");
      log.info(`Memory lock held for ${repo}; skipping for task ${taskId}`);
      const tracker = await startMemoryRun({ ...opts, kind: "skip", sessionPath: null });
      await tracker.complete();
      await finalizeInlineMemoryStage(taskId, "skipped");
    }
  } catch (err) {
    const message = toErrorMessage(err);
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
  const tracker = await startMemoryRun({ ...opts, kind: "cold", sessionPath });
  attachRunIdToSpan(tracker);

  let result;
  try {
    result = await runStage<readonly Zone[]>({
      taskId: opts.taskId,
      stage: "memory",
      cwd: worktree,
      systemPrompt: coldSystemPrompt(opts.repo, memoryDir(opts.repo), worktree, manifest),
      initialPrompt: coldInitialPrompt(opts.repo, memoryDir(opts.repo)),
      model: resolveModel("PI_MODEL_MEMORY"),
      sendTelegram: opts.sendTelegram,
      chatId: opts.chatId,
      stageLabel: "Memory (cold)",
      extensions: cap.extensions,
      envOverrides: cap.envOverrides,
      timeoutMs: COLD_TIMEOUT_MS,
      ...(tracker.runId ? { sessionEventMeta: { memoryRunId: tracker.runId } } : {}),
      postValidate: () => validateColdStage(opts.repo),
    });
  } catch (err) {
    await tracker.fail(err);
    throw err;
  }

  if (!result.ok) {
    await tracker.fail(`cold validation failed: ${result.reason}`);
    return;
  }

  if (!result.data) {
    await tracker.fail("cold validation did not return zones");
    return;
  }

  await writeState(opts.repo, headSha, result.data);
  await tracker.complete({ sha: headSha, zoneCount: result.data.length });
}

async function validateColdStage(repo: string): Promise<StageValidation<readonly Zone[]>> {
  const result = await validateColdOutput(repo);
  return result.valid
    ? { valid: true, data: result.zones }
    : { valid: false, reason: result.reason };
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
  const tracker = await startMemoryRun({ ...opts, kind: "warm", sessionPath });
  attachRunIdToSpan(tracker);

  let result;
  try {
    result = await runStage({
      taskId: opts.taskId,
      stage: "memory",
      cwd: worktree,
      systemPrompt: warmSystemPrompt(
        opts.repo, memoryDir(opts.repo), worktree,
        state.zones, snapshot, bucketed, hints,
      ),
      initialPrompt: warmInitialPrompt(opts.repo, memoryDir(opts.repo)),
      model: resolveModel("PI_MODEL_MEMORY"),
      sendTelegram: opts.sendTelegram,
      chatId: opts.chatId,
      stageLabel: "Memory (warm)",
      extensions: cap.extensions,
      envOverrides: cap.envOverrides,
      timeoutMs: WARM_TIMEOUT_MS,
      ...(tracker.runId ? { sessionEventMeta: { memoryRunId: tracker.runId } } : {}),
      postValidate: () => validateWarmOutput(
        opts.repo, state.zones, stateHashBefore, zoneDirsBefore,
      ),
    });
  } catch (err) {
    await tracker.fail(err);
    throw err;
  }

  if (!result.ok) {
    await tracker.fail(`warm validation failed: ${result.reason}`);
    return;
  }

  await writeState(opts.repo, headSha, state.zones);
  await tracker.complete({ sha: headSha, zoneCount: state.zones.length });
}

// --- Helpers ---

/**
 * Write the `task_stages` row + emit the terminal stage_update for paths
 * that don't spawn a pi session. Best-effort: a missing tasks row (manual
 * test) silently skips the DB write while still emitting SSE.
 */
async function finalizeInlineMemoryStage(taskId: string, status: StageStatus): Promise<void> {
  if (isPersistedTaskId(taskId)) {
    const stage = await queries.createTaskStage({ taskId, stage: "memory" }).catch(() => null);
    if (stage) {
      await queries.updateTaskStage(stage.id, { status, completedAt: new Date() }).catch(() => {});
    }
  }
  emit({ type: "stage_update", taskId, stage: "memory", status });
}

/** Attach the memory_runs id to the active OTel span when present. */
function attachRunIdToSpan(tracker: MemoryRunTracker): void {
  if (tracker.runId) trace.getActiveSpan()?.setAttribute(Goodboy.MemoryRunId, tracker.runId);
}

