/**
 * Commands emitted by the pure translator. The IO adapter in index.ts
 * turns these into OTel span operations. Kept as a discriminated union
 * so the translator is fully unit-testable without OTel.
 */

import type { SessionHeader } from "../../shared/session.js";

export type SpanCommand =
  | StartChatSpan
  | EndChatSpan
  | StartToolSpan
  | EndToolSpan
  | StageEvent
  | AccumulateCost;

export interface StartChatSpan {
  type: "chat.start";
  /** Stable id; we use the assistant SessionMessageEntry.id. */
  key: string;
  model: string;
  provider: string;
  api: string;
  startedAtMs: number;
}

export interface EndChatSpan {
  type: "chat.end";
  key: string;
  endedAtMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  stopReason: string;
  /** First N chars of concatenated assistant text. */
  textPreview: string;
  /** Concatenated thinking blocks (if any). */
  thinkingPreview?: string;
  errorMessage?: string;
}

export interface StartToolSpan {
  type: "tool.start";
  /** `toolCall.id` -- also the key we look up in `tool.end`. */
  key: string;
  name: string;
  /** Already truncated. */
  argsJson: string;
  startedAtMs: number;
  /** Chat span this tool was called from. */
  parentChatKey: string;
}

export interface EndToolSpan {
  type: "tool.end";
  key: string;
  endedAtMs: number;
  /** Already truncated. */
  outputPreview: string;
  isError: boolean;
}

export interface StageEvent {
  type: "stage.event";
  /** `compaction` | `model_change` | `bash_execution` | ... */
  name: string;
  attributes: Record<string, string | number | boolean>;
}

export interface AccumulateCost {
  type: "cost.add";
  usd: number;
}

export interface TranslatorState {
  sessionHeader?: SessionHeader;
  openChatKey: string | null;
  openToolIds: Set<string>;
}

export function initialState(): TranslatorState {
  return { openChatKey: null, openToolIds: new Set() };
}
