/**
 * Pure log-stream processing. Correlates tool lifecycle entries into groups,
 * extracts output text, and sniffs for diffs / file lists. No React, no IO.
 */

import type { LogEntry } from "@dashboard/lib/api";

// --- Types ---

export interface ToolGroup {
  type: "group";
  startSeq: number;
  toolName: string;
  toolCallId?: string;
  summary: string;
  entries: LogEntry[];
  ok: boolean;
  durationMs?: number;
  /** True once a `tool_end` entry has been seen for this group. */
  done: boolean;
}

export type ProcessedItem = { type: "line"; entry: LogEntry } | ToolGroup;

// --- Grouping ---

/**
 * Correlate `tool_start` with subsequent update/output/end entries. Prefers
 * `toolCallId` from meta; falls back to `tool` name for legacy logs. Legacy
 * text-carried raw JSON tool events are pulled in too.
 */
export function groupToolCalls(entries: LogEntry[]): ProcessedItem[] {
  const result: ProcessedItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind !== "tool_start") {
      result.push({ type: "line", entry });
      i++;
      continue;
    }

    const toolName = (entry.meta?.tool as string) ?? "tool";
    const toolCallId = entry.meta?.toolCallId as string | undefined;
    const matches = (e: LogEntry): boolean =>
      toolCallId ? e.meta?.toolCallId === toolCallId : e.meta?.tool === toolName;

    const group: LogEntry[] = [entry];
    let ok = true;
    let durationMs: number | undefined;
    let done = false;
    let j = i + 1;

    while (j < entries.length) {
      const next = entries[j];
      const isUpdate =
        (next.kind === "tool_output" || next.kind === "tool_update") && matches(next);
      const isEnd = next.kind === "tool_end" && matches(next);
      const isLegacyJson = next.kind === "text" && isRawToolJson(next.text);

      if (isUpdate || isLegacyJson) {
        group.push(next);
        j++;
      } else if (isEnd) {
        group.push(next);
        ok = (next.meta?.ok as boolean) ?? true;
        durationMs = next.meta?.durationMs as number | undefined;
        done = true;
        j++;
        break;
      } else {
        break;
      }
    }

    result.push({
      type: "group",
      startSeq: entry.seq,
      toolName,
      toolCallId,
      summary: entry.text,
      entries: group,
      ok,
      durationMs,
      done,
    });
    i = j;
  }

  return result;
}

export function toolGroupKey(group: ToolGroup): string {
  const firstTs = group.entries[0]?.ts ?? "";
  return `${firstTs}:${group.startSeq}:${group.toolCallId ?? group.toolName}`;
}

// --- Output extraction ---

/** Extract the meaningful text from a grouped tool's entries. Handles both modern and legacy shapes. */
export function extractToolOutput(entries: LogEntry[]): string {
  const outputs = entries.filter((e) => e.kind === "tool_output");
  if (outputs.length > 0) return outputs.map((e) => e.text).join("\n");

  for (const entry of entries) {
    if (entry.kind === "text" && isRawToolJson(entry.text)) {
      const extracted = extractTextFromToolJson(entry.text);
      if (extracted) return extracted;
    }
  }
  return "(no output)";
}

/** Parse a legacy tool-event JSON blob and return its text content, or null on failure. */
export function extractTextFromToolJson(raw: string): string | null {
  try {
    const obj = JSON.parse(raw);
    if (obj?.result?.content) {
      const texts: string[] = [];
      for (const block of obj.result.content) {
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
      if (texts.length > 0) return texts.join("\n");
    }
    if (typeof obj?.result === "string") return obj.result;
    return null;
  } catch {
    return null;
  }
}

/** True when a `text` entry is actually a pi tool event JSON that leaked through. */
export function isRawToolJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  if (
    !trimmed.includes('"tool_execution_end"') &&
    !trimmed.includes('"tool_execution_start"') &&
    !trimmed.includes('"tool_call"')
  ) {
    return false;
  }
  try {
    const obj = JSON.parse(trimmed);
    return (
      typeof obj === "object" &&
      obj !== null &&
      (obj.type === "tool_execution_end" ||
        obj.type === "tool_execution_start" ||
        obj.type === "tool_call")
    );
  } catch {
    return false;
  }
}

// --- Summary + content sniffers ---

const BASH_SUMMARY_CAP = 120;

export function formatToolSummary(toolName: string, raw: string): string {
  if (toolName === "bash" && raw.length > BASH_SUMMARY_CAP) {
    return raw.slice(0, BASH_SUMMARY_CAP) + "...";
  }
  return raw;
}

export function detectDiff(text: string): boolean {
  const lines = text.split("\n").slice(0, 10);
  let markers = 0;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")) markers++;
  }
  return markers >= 3;
}

export function detectFileList(text: string): boolean {
  const lines = text.split("\n").slice(0, 10);
  let paths = 0;
  for (const line of lines) {
    if (line.match(/^[\w./-]+\.\w{1,6}$/)) paths++;
  }
  return paths >= 3;
}

// --- Subagent worker derivation ---

export type SubagentWorkerStatus = "pending" | "running" | "completed" | "failed";

export interface SubagentWorker {
  index: number;
  agent: string;
  task: string;
  status: SubagentWorkerStatus;
  currentTool?: string;
  toolCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
  finalOutput?: string;
}

export interface SubagentSummary {
  mode: string;
  taskCount: number;
  workers: SubagentWorker[];
  completedCount: number;
  failedCount: number;
  runningCount: number;
  totalCost: number;
}

/** Flatten a subagent ToolGroup into a deterministic per-worker view. */
export function deriveSubagentSummary(group: ToolGroup): SubagentSummary {
  const start = group.entries[0];
  const end = group.entries.find((e) => e.kind === "tool_end");
  const latestUpdate = [...group.entries].reverse().find((e) => e.kind === "tool_update");
  const outputs = group.entries.filter((e) => e.kind === "tool_output");

  const mode = (start.meta?.mode as string) ?? "parallel";
  const taskCount = (start.meta?.taskCount as number) ?? 0;
  const tasks = (start.meta?.tasks as Array<{ agent: string; task: string }>) ?? [];
  const progress = (latestUpdate?.meta?.progress as Partial<SubagentWorker>[] | undefined) ?? [];

  const workers: SubagentWorker[] = tasks.map((t, i) => ({
    index: i,
    agent: t.agent,
    task: t.task,
    status: "pending",
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
  }));

  for (const p of progress) {
    if (typeof p.index === "number" && workers[p.index]) {
      workers[p.index] = { ...workers[p.index], ...p };
    }
  }

  for (const o of outputs) {
    const i = o.meta?.workerIndex as number | undefined;
    if (i === undefined || !workers[i]) continue;
    workers[i] = {
      ...workers[i],
      status: (o.meta?.status as SubagentWorkerStatus) ?? workers[i].status,
      tokens: (o.meta?.tokens as number | undefined) ?? workers[i].tokens,
      durationMs: (o.meta?.durationMs as number | undefined) ?? workers[i].durationMs,
      error: (o.meta?.error as string | undefined) ?? workers[i].error,
      finalOutput: o.text,
    };
  }

  return {
    mode,
    taskCount,
    workers,
    completedCount:
      (end?.meta?.completedCount as number | undefined) ??
      workers.filter((w) => w.status === "completed").length,
    failedCount:
      (end?.meta?.failedCount as number | undefined) ??
      workers.filter((w) => w.status === "failed").length,
    runningCount: workers.filter((w) => w.status === "running").length,
    totalCost: (end?.meta?.totalCost as number | undefined) ?? 0,
  };
}
