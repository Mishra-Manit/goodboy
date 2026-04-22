/**
 * Subscribes to a pi session file and turns entries into live OTel spans
 * nested under the current stage span. Returns a disposer; call it in
 * `runStage`'s finally block so we don't leak watchers.
 *
 * This is the IO half of the bridge -- all parsing lives in translate.ts.
 */

import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { watchSessionFile } from "../../core/pi/session-file.js";
import { createLogger } from "../../shared/logger.js";
import { getTracer } from "../tracer.js";
import { GenAi, Goodboy, truncate } from "../attributes.js";
import { translate, initialState } from "./translate.js";
import type { SpanCommand, TranslatorState } from "./types.js";

const log = createLogger("bridge");

export interface BridgeOptions {
  sessionPath: string;
  /** Span the bridged chat/tool spans are parented under. */
  stageSpan: Span;
  taskId: string;
  /**
   * Model the session was spawned with. Used to suppress the no-op
   * `model_change` event pi writes at session start (it's a "current
   * model" record, not a change notification).
   */
  initialModel?: string;
}

/**
 * Tail a pi session JSONL and emit OTel spans for every assistant turn
 * and tool call. Returns a disposer that stops watching and force-closes
 * any spans that never saw their end (e.g. killed session).
 */
export function bridgeSessionToOtel({
  sessionPath,
  stageSpan,
  taskId,
  initialModel,
}: BridgeOptions): () => void {
  const tracer = getTracer();
  const chatSpans = new Map<string, Span>();
  const toolSpans = new Map<string, Span>();
  let state: TranslatorState = initialState();
  if (initialModel) state = { ...state, lastModelId: initialModel };
  let totalCost = 0;

  const stageCtx = trace.setSpan(context.active(), stageSpan);

  function handle(cmd: SpanCommand): void {
    switch (cmd.type) {
      case "chat.start": {
        const span = tracer.startSpan(
          `gen_ai.chat ${cmd.model}`,
          {
            attributes: {
              [GenAi.System]: "pi",
              [GenAi.OperationName]: "chat",
              [GenAi.RequestModel]: cmd.model,
              [GenAi.ResponseModel]: cmd.model,
              [GenAi.Provider]: cmd.provider,
              [GenAi.Api]: cmd.api,
              [Goodboy.TaskId]: taskId,
            },
            startTime: cmd.startedAtMs,
          },
          stageCtx,
        );
        chatSpans.set(cmd.key, span);
        return;
      }
      case "chat.end": {
        const span = chatSpans.get(cmd.key);
        if (!span) return;
        span.setAttributes({
          [GenAi.UsageInputTokens]: cmd.usage.inputTokens,
          [GenAi.UsageOutputTokens]: cmd.usage.outputTokens,
          [GenAi.UsageCacheReadTokens]: cmd.usage.cacheReadTokens,
          [GenAi.UsageCacheWriteTokens]: cmd.usage.cacheWriteTokens,
          [Goodboy.CostUsd]: cmd.usage.costUsd,
          [Goodboy.StopReason]: cmd.stopReason,
          [GenAi.ResponseFinishReasons]: [cmd.stopReason],
        });
        if (cmd.textPreview) span.addEvent("assistant.text", { text: cmd.textPreview });
        if (cmd.thinkingPreview) span.addEvent("assistant.thinking", { text: cmd.thinkingPreview });
        if (cmd.errorMessage) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(cmd.errorMessage, 512) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(cmd.endedAtMs);
        chatSpans.delete(cmd.key);
        return;
      }
      case "tool.start": {
        const parent = chatSpans.get(cmd.parentChatKey) ?? stageSpan;
        const parentCtx = trace.setSpan(context.active(), parent);
        const span = tracer.startSpan(
          `execute_tool ${cmd.name}`,
          {
            attributes: {
              [GenAi.OperationName]: "execute_tool",
              [GenAi.ToolName]: cmd.name,
              [GenAi.ToolCallId]: cmd.key,
              [Goodboy.ToolArgs]: cmd.argsJson,
            },
            startTime: cmd.startedAtMs,
          },
          parentCtx,
        );
        toolSpans.set(cmd.key, span);
        return;
      }
      case "tool.end": {
        const span = toolSpans.get(cmd.key);
        if (!span) return;
        span.setAttributes({
          [Goodboy.ToolOutput]: cmd.outputPreview,
          [Goodboy.ToolIsError]: cmd.isError,
        });
        span.setStatus({ code: cmd.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end(cmd.endedAtMs);
        toolSpans.delete(cmd.key);
        return;
      }
      case "stage.event": {
        stageSpan.addEvent(cmd.name, cmd.attributes);
        return;
      }
      case "cost.add": {
        totalCost += cmd.usd;
        stageSpan.setAttribute(Goodboy.CostUsd, Number(totalCost.toFixed(6)));
        return;
      }
    }
  }

  const stopWatcher = watchSessionFile(sessionPath, (entry) => {
    try {
      const out = translate(state, entry);
      state = out.state;
      for (const cmd of out.commands) handle(cmd);
    } catch (err) {
      log.warn(`Bridge error on entry: ${String(err)}`);
    }
  });

  return () => {
    stopWatcher();
    // Force-close any spans the bridge didn't see an end for (killed session).
    const now = Date.now();
    for (const span of toolSpans.values()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session killed" });
      span.end(now);
    }
    for (const span of chatSpans.values()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session killed" });
      span.end(now);
    }
    toolSpans.clear();
    chatSpans.clear();
  };
}
