/**
 * Pure helpers for rendering pi session transcripts. No React, no IO.
 */

import type { FileEntry, SessionEntry, SessionMessageEntry, ToolCall, ToolResultMessage } from "@dashboard/lib/api";

// --- Filtering ---

const HIDDEN_TYPES = new Set([
  "session",
  "model_change",
  "thinking_level_change",
  "label",
  "session_info",
]);

/** Drop header + bookkeeping entries that don't carry any message content. */
export function visibleEntries(entries: FileEntry[]): SessionEntry[] {
  return entries.filter((e) => !HIDDEN_TYPES.has(e.type)) as SessionEntry[];
}

/** Dedupe by entry id, preserving first-seen order. */
export function dedupeById(entries: FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  const out: FileEntry[] = [];
  for (const e of entries) {
    const key = "id" in e && typeof e.id === "string" ? e.id : `${e.type}:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// --- Tool result pairing ---

/**
 * Map `toolCallId` -> the `ToolResultMessage` entry that answers it. Used to
 * attach a completed tool call to its originating `toolCall` content block.
 */
export function buildToolResultIndex(entries: SessionEntry[]): Map<string, SessionMessageEntry> {
  const map = new Map<string, SessionMessageEntry>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role !== "toolResult") continue;
    map.set(m.toolCallId, entry);
  }
  return map;
}

// --- Content helpers ---

/** Concatenate all text blocks in a message's content. Images skipped. */
export function joinText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// --- Subagent parsers ---

export interface SubagentWorker {
  agent: string;
  task: string;
  ok?: boolean;
  tokens: number;
  durationMs: number;
  finalOutput: string;
  error?: string;
}

interface RawWorkerResult {
  agent?: string;
  task?: string;
  exitCode?: number;
  error?: string;
  finalOutput?: string;
  usage?: { input?: number; output?: number };
  progress?: { durationMs?: number };
}

/** Detect the subagent execution mode from call arguments. */
export function detectSubagentMode(call: ToolCall): string {
  const a = call.arguments ?? {};
  if (Array.isArray(a.chain)) return "chain";
  if (Array.isArray(a.tasks)) return "parallel";
  if (typeof a.action === "string") return a.action;
  return "single";
}

/** Extract planned tasks from the subagent call arguments. */
export function extractPlannedTasks(call: ToolCall): Array<{ agent: string; task: string }> {
  const a = call.arguments ?? {};
  if (Array.isArray(a.tasks)) return a.tasks.map(toTaskShape);
  if (Array.isArray(a.chain)) return a.chain.map(toTaskShape);
  if (typeof a.agent === "string") return [{ agent: a.agent, task: trimTask(a.task) }];
  return [];
}

/** Create a pending worker from a planned task. */
export function toPendingWorker(t: { agent: string; task: string }): SubagentWorker {
  return { agent: t.agent, task: t.task, tokens: 0, durationMs: 0, finalOutput: "" };
}

/** Extract completed worker results from a tool-result message. */
export function extractWorkers(
  result: ToolResultMessage,
  planned: Array<{ agent: string; task: string }>,
): SubagentWorker[] {
  const details = (result.details ?? {}) as { results?: RawWorkerResult[] };
  const rawResults = details.results ?? [];
  if (rawResults.length === 0) return planned.map(toPendingWorker);

  return rawResults.map((r, i) => {
    const fallback = planned[i];
    const ok = typeof r.exitCode === "number" ? r.exitCode === 0 : !r.error;
    const tokens = (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
    return {
      agent: r.agent ?? fallback?.agent ?? "?",
      task: trimTask(r.task ?? fallback?.task ?? ""),
      ok,
      tokens,
      durationMs: r.progress?.durationMs ?? 0,
      finalOutput: r.finalOutput ?? "",
      error: r.error,
    };
  });
}

/** Produce a compact summary string for the worker results. */
export function summarizeWorkers(workers: SubagentWorker[], done: boolean): string {
  if (!done) return `${workers.length} pending`;
  const okCount = workers.filter((w) => w.ok).length;
  const failCount = workers.filter((w) => w.ok === false).length;
  const failSuffix = failCount > 0 ? ` \u00b7 ${failCount} failed` : "";
  return `${okCount}/${workers.length} ok${failSuffix}`;
}

// --- Internal helpers ---

function toTaskShape(t: unknown): { agent: string; task: string } {
  const o = (t ?? {}) as Record<string, unknown>;
  return { agent: String(o.agent ?? "?"), task: trimTask(o.task) };
}

export function trimTask(task: unknown): string {
  if (typeof task !== "string") return "";
  return task.length > 160 ? task.slice(0, 160) + "..." : task;
}
