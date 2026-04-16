import type { LogEntryKind } from "../shared/types.js";

/**
 * Per-toolCallId throttle for high-frequency tool_execution_update events.
 * Subagent calls stream progress for N parallel workers; without coalescing
 * the dashboard and disk would be swamped. We keep the latest snapshot per
 * toolCallId and emit at most once every THROTTLE_MS.
 */

const THROTTLE_MS = 250;

type EmitLog = (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;

interface SubagentProgress {
  index: number;
  agent: string;
  status: string;
  task: string;
  currentTool?: string;
  toolCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
}

interface PartialDetails {
  mode?: string;
  progress?: Array<Record<string, unknown>>;
  progressSummary?: { toolCount?: number; tokens?: number; durationMs?: number };
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout> | null;
  latest: PartialDetails;
  updateSeq: number;
}

export interface SubagentCoalescer {
  /** Feed a new partialResult; emits a coalesced tool_update no faster than every 250ms. */
  push: (toolCallId: string, partialResult: unknown) => void;
  /** Drop pending state for a toolCallId (call on tool_execution_end). */
  end: (toolCallId: string) => void;
  /** Flush all pending timers immediately. Call during session kill. */
  flushAll: () => void;
}

/**
 * Strip high-volume / rarely useful fields from a progress entry before we
 * persist it to disk and ship it over SSE. recentTools and recentOutput are
 * per-worker arrays that balloon quickly and aren't needed for dashboard
 * rendering -- we display the rolled-up status/currentTool/toolCount instead.
 */
function slimProgress(raw: Record<string, unknown>): SubagentProgress {
  return {
    index: Number(raw.index ?? 0),
    agent: String(raw.agent ?? ""),
    status: String(raw.status ?? "pending"),
    task: String(raw.task ?? ""),
    currentTool: raw.currentTool != null ? String(raw.currentTool) : undefined,
    toolCount: Number(raw.toolCount ?? 0),
    tokens: Number(raw.tokens ?? 0),
    durationMs: Number(raw.durationMs ?? 0),
    error: raw.error != null ? String(raw.error) : undefined,
  };
}

function summarizeProgress(progress: SubagentProgress[]): string {
  if (progress.length === 0) return "subagent update";
  const counts = { running: 0, completed: 0, failed: 0, pending: 0 };
  for (const p of progress) {
    if (p.status === "running") counts.running++;
    else if (p.status === "completed") counts.completed++;
    else if (p.status === "failed") counts.failed++;
    else counts.pending++;
  }
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.completed) parts.push(`${counts.completed} completed`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.pending) parts.push(`${counts.pending} pending`);
  return parts.join(" \u00b7 ");
}

export function createSubagentCoalescer(emitLog: EmitLog): SubagentCoalescer {
  const pending = new Map<string, PendingEntry>();

  function flush(toolCallId: string): void {
    const entry = pending.get(toolCallId);
    if (!entry) return;
    entry.timer = null;

    const rawProgress = entry.latest.progress ?? [];
    const progress = rawProgress.map(slimProgress);
    const text = summarizeProgress(progress);

    emitLog("tool_update", text, {
      tool: "subagent",
      toolCallId,
      updateSeq: entry.updateSeq,
      mode: entry.latest.mode,
      progress,
      progressSummary: entry.latest.progressSummary,
    });
  }

  return {
    push(toolCallId, partialResult) {
      if (!partialResult || typeof partialResult !== "object") return;
      const details = partialResult as PartialDetails;

      const existing = pending.get(toolCallId);
      const updateSeq = (existing?.updateSeq ?? 0) + 1;

      if (existing) {
        existing.latest = details;
        existing.updateSeq = updateSeq;
        if (existing.timer) return; // already scheduled
        existing.timer = setTimeout(() => flush(toolCallId), THROTTLE_MS);
        return;
      }

      // First update for this toolCallId -- emit immediately so the UI sees
      // something within one tick, then subsequent updates coalesce.
      pending.set(toolCallId, { timer: null, latest: details, updateSeq });
      flush(toolCallId);
    },

    end(toolCallId) {
      const entry = pending.get(toolCallId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(toolCallId);
    },

    flushAll() {
      for (const [toolCallId, entry] of pending.entries()) {
        if (entry.timer) {
          clearTimeout(entry.timer);
          flush(toolCallId);
        }
      }
      pending.clear();
    },
  };
}
