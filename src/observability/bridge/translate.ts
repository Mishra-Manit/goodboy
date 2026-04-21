/**
 * Pure FileEntry -> SpanCommand translator. No OTel, no IO, no fs. The
 * IO wrapper in ./index.ts subscribes to watchSessionFile and runs each
 * entry through `translate`, updating state and emitting commands.
 *
 * Every call is: (prevState, entry) -> (nextState, commands).
 */

import type {
  FileEntry,
  SessionMessageEntry,
  AssistantMessage,
  ToolResultMessage,
} from "../../shared/session.js";
import { truncate } from "../attributes.js";
import type { SpanCommand, TranslatorState } from "./types.js";
import { initialState } from "./types.js";

/** Max chars kept for any text/thinking/tool-output preview on a span event. */
const MAX_PREVIEW = 2000;

export { initialState };

export function translate(
  state: TranslatorState,
  entry: FileEntry,
): { state: TranslatorState; commands: SpanCommand[] } {
  if (entry.type === "session") {
    return { state: { ...state, sessionHeader: entry }, commands: [] };
  }
  if (entry.type === "message") {
    return handleMessage(state, entry);
  }
  if (
    entry.type === "model_change" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  ) {
    return {
      state,
      commands: [
        {
          type: "stage.event",
          name: entry.type,
          attributes: flattenAttrs(entry),
        },
      ],
    };
  }
  return { state, commands: [] };
}

// --- Message handlers ---

function handleMessage(
  state: TranslatorState,
  entry: SessionMessageEntry,
): { state: TranslatorState; commands: SpanCommand[] } {
  const m = entry.message;
  if (m.role === "assistant") return handleAssistant(state, entry, m);
  if (m.role === "toolResult") return handleToolResult(state, entry, m);
  if (m.role === "bashExecution") {
    return {
      state,
      commands: [
        {
          type: "stage.event",
          name: "bash_execution",
          attributes: {
            command: truncate(m.command, 512),
            exit_code: m.exitCode ?? -1,
            cancelled: m.cancelled,
          },
        },
      ],
    };
  }
  // user / custom messages: ignored for span purposes.
  return { state, commands: [] };
}

function handleAssistant(
  state: TranslatorState,
  entry: SessionMessageEntry,
  m: AssistantMessage,
): { state: TranslatorState; commands: SpanCommand[] } {
  const key = entry.id;
  const commands: SpanCommand[] = [];

  commands.push({
    type: "chat.start",
    key,
    model: m.model,
    provider: m.provider,
    api: m.api,
    startedAtMs: m.timestamp,
  });

  const texts = m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const thinkings = m.content
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");

  commands.push({
    type: "chat.end",
    key,
    endedAtMs: m.timestamp,
    usage: {
      inputTokens: m.usage.input,
      outputTokens: m.usage.output,
      cacheReadTokens: m.usage.cacheRead,
      cacheWriteTokens: m.usage.cacheWrite,
      costUsd: m.usage.cost.total,
    },
    stopReason: m.stopReason,
    textPreview: truncate(texts, MAX_PREVIEW),
    thinkingPreview: thinkings ? truncate(thinkings, MAX_PREVIEW) : undefined,
    errorMessage: m.errorMessage,
  });

  const openedToolIds = new Set(state.openToolIds);
  for (const block of m.content) {
    if (block.type !== "toolCall") continue;
    commands.push({
      type: "tool.start",
      key: block.id,
      name: block.name,
      argsJson: truncate(JSON.stringify(block.arguments)),
      startedAtMs: m.timestamp,
      parentChatKey: key,
    });
    openedToolIds.add(block.id);
  }

  commands.push({ type: "cost.add", usd: m.usage.cost.total });
  return {
    state: { ...state, openChatKey: key, openToolIds: openedToolIds },
    commands,
  };
}

function handleToolResult(
  state: TranslatorState,
  _entry: SessionMessageEntry,
  m: ToolResultMessage,
): { state: TranslatorState; commands: SpanCommand[] } {
  if (!state.openToolIds.has(m.toolCallId)) {
    // Result without a matching call -- possible with pi replays; skip.
    return { state, commands: [] };
  }
  const outputText = m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const nextOpen = new Set(state.openToolIds);
  nextOpen.delete(m.toolCallId);
  return {
    state: { ...state, openToolIds: nextOpen },
    commands: [
      {
        type: "tool.end",
        key: m.toolCallId,
        endedAtMs: m.timestamp,
        outputPreview: truncate(outputText, MAX_PREVIEW),
        isError: m.isError,
      },
    ],
  };
}

// --- Helpers ---

function flattenAttrs(entry: FileEntry): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entry as unknown as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = truncate(JSON.stringify(v), 1024);
    }
  }
  return out;
}
