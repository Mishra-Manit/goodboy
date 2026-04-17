import type { LogEntry } from "@dashboard/lib/api";

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
    const tsCompare = a.ts.localeCompare(b.ts);
    if (tsCompare !== 0) return tsCompare;

    const seqCompare = a.seq - b.seq;
    if (seqCompare !== 0) return seqCompare;

    return logEntryKey(a).localeCompare(logEntryKey(b));
  });
}

export function mergeLogEntries(...groups: LogEntry[][]): LogEntry[] {
  const merged = new Map<string, LogEntry>();

  for (const group of groups) {
    for (const entry of group) {
      merged.set(logEntryKey(entry), entry);
    }
  }

  return sortLogEntries([...merged.values()]);
}
