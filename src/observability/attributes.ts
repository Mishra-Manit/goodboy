/**
 * All attribute names used in goodboy spans. Split into OTel GenAI
 * semantic conventions and goodboy-specific keys so consumers can tell
 * them apart at a glance.
 *
 * Ref: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

export const GenAi = {
  System: "gen_ai.system",
  OperationName: "gen_ai.operation.name",
  RequestModel: "gen_ai.request.model",
  ResponseModel: "gen_ai.response.model",
  ResponseFinishReasons: "gen_ai.response.finish_reasons",
  UsageInputTokens: "gen_ai.usage.input_tokens",
  UsageOutputTokens: "gen_ai.usage.output_tokens",
  UsageCacheReadTokens: "gen_ai.usage.cache_read_tokens",
  UsageCacheWriteTokens: "gen_ai.usage.cache_write_tokens",
  ToolName: "gen_ai.tool.name",
  ToolCallId: "gen_ai.tool.call.id",
  AgentName: "gen_ai.agent.name",
  ConversationId: "gen_ai.conversation.id",
  Provider: "gen_ai.provider",
  Api: "gen_ai.api",
} as const;

export const Goodboy = {
  TaskId: "goodboy.task_id",
  Stage: "goodboy.stage",
  PipelineKind: "goodboy.pipeline.kind",
  Repo: "goodboy.repo",
  Branch: "goodboy.branch",
  PrSessionId: "goodboy.pr_session.id",
  PrSessionRunId: "goodboy.pr_session.run_id",
  PrNumber: "goodboy.pr.number",
  CostUsd: "goodboy.cost_usd",
  ToolArgs: "goodboy.tool.args",
  ToolOutput: "goodboy.tool.output",
  ToolIsError: "goodboy.tool.is_error",
  StopReason: "goodboy.stop_reason",
  PiSessionPath: "goodboy.pi_session_path",
} as const;

/** 8 KiB truncation budget per attribute to keep span payloads small. */
export const MAX_ATTR_STRING = 8 * 1024;

/** Truncate a string to `max` bytes, appending a marker that shows how much was dropped. */
export function truncate(s: string, max = MAX_ATTR_STRING): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max}b]`;
}
