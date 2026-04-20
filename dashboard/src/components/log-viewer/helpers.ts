/**
 * Pure helpers for rendering pi session transcripts. No React, no IO.
 */

import type { FileEntry, SessionEntry, SessionMessageEntry } from "@dashboard/lib/api";

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
