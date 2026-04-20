/**
 * Pure helpers for stable log-entry identity, ordering, and disk+live merging.
 * Grouping and content sniffing live in `log-grouping.ts`.
 */

import type { LogEntry } from "@dashboard/lib/api";

/** Stable key for deduping entries across SSE + disk snapshots. */
export function logEntryKey(entry: LogEntry): string {
  return [
    entry.ts,
    entry.seq,
    entry.kind,
    entry.text,
    String(entry.meta?.toolCallId ?? ""),
    String(entry.meta?.runId ?? ""),
    String(entry.meta?.tool ?? ""),
  ].join("\u0001");
}

export function sortLogEntries(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => {
    const byTs = a.ts.localeCompare(b.ts);
    if (byTs !== 0) return byTs;
    const bySeq = a.seq - b.seq;
    if (bySeq !== 0) return bySeq;
    return logEntryKey(a).localeCompare(logEntryKey(b));
  });
}

/** Merge multiple log-entry arrays, dedupe by `logEntryKey`, return sorted. */
export function mergeLogEntries(...groups: LogEntry[][]): LogEntry[] {
  const merged = new Map<string, LogEntry>();
  for (const group of groups) {
    for (const entry of group) merged.set(logEntryKey(entry), entry);
  }
  return sortLogEntries([...merged.values()]);
}
