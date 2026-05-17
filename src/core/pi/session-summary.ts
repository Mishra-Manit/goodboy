/** Summarize raw pi JSONL files into compact DB metrics. */

import type { AssistantMessage, FileEntry } from "../../shared/contracts/session.js";

export interface SessionSummary {
  piSessionId: string;
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  costUsd: string | null;
  toolCallCount: number;
}

/** Extract compact metrics from a pi session JSONL entry list. */
export function summarizeSessionEntries(entries: readonly FileEntry[]): SessionSummary | null {
  const header = entries.find((entry) => entry.type === "session");
  if (!header || header.type !== "session") return null;

  const timestamps = entries
    .map((entry) => Date.parse(entry.timestamp))
    .filter((value) => Number.isFinite(value));
  const started = Date.parse(header.timestamp);
  const ended = timestamps.length ? Math.max(...timestamps) : started;

  let model: string | null = null;
  let totalTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  let toolCallCount = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    model = message.model ?? model;
    if (message.usage) {
      sawUsage = true;
      totalTokens += message.usage.totalTokens ?? 0;
      costUsd += message.usage.cost?.total ?? 0;
    }
    toolCallCount += message.content.filter((block) => block.type === "toolCall").length;
  }

  return {
    piSessionId: header.id,
    model,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
    totalTokens: sawUsage ? totalTokens : null,
    costUsd: sawUsage ? costUsd.toFixed(6) : null,
    toolCallCount,
  };
}
