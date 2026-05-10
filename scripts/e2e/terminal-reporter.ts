/** Concise live terminal output for E2E SSE events. */

import type { ToolCall, ToolResultMessage, Usage } from "../../src/shared/contracts/session.js";
import type { SSEEvent, StageName } from "../../src/shared/domain/types.js";

const FAILURE_OUTPUT_LINES = 40;
const MAX_TARGET_CHARS = 120;

interface UsageTotals {
  totalTokens: number;
  costTotal: number;
}

interface PendingToolCall {
  stage: StageName;
  variant?: number;
  call: ToolCall;
}

/** Create the single default terminal reporter: concise stages plus tool activity. */
export function createTerminalReporter(): (event: SSEEvent) => void {
  const startedAt = new Map<string, number>();
  const usageByStage = new Map<string, UsageTotals>();
  const toolCalls = new Map<string, PendingToolCall>();

  return (event) => {
    if (event.type === "task_update") {
      console.log(`\n[task ${short(event.taskId)}] ${event.status}${event.kind ? ` (${event.kind})` : ""}`);
      return;
    }

    if (event.type === "stage_update") {
      const key = stageKey(event.stage, event.variant);
      if (event.status === "running") {
        startedAt.set(key, Date.now());
        console.log(`\n[${formatStage(event.stage, event.variant)}] running`);
        return;
      }

      const elapsed = Date.now() - (startedAt.get(key) ?? Date.now());
      const usage = usageByStage.get(key) ?? emptyUsage();
      console.log(
        `[${formatStage(event.stage, event.variant)}] ${event.status}  ${formatDuration(elapsed)}  ${formatTokens(usage.totalTokens)} tok  ${formatCost(usage.costTotal)}`,
      );
      return;
    }

    if (event.type === "memory_run_update") {
      console.log(`[memory ${short(event.runId)}] ${event.kind} ${event.status}`);
      return;
    }

    if (event.type === "pr_session_update") {
      console.log(`[pr-session ${short(event.prSessionId)}] ${event.running ? "running" : "idle"}`);
      return;
    }

    if (event.type !== "session_entry" || event.scope !== "task" || event.entry.type !== "message" || !event.stage) return;

    const key = stageKey(event.stage, event.variant);
    const message = event.entry.message;
    if (message.role === "assistant") {
      addUsageToMap(usageByStage, key, message.usage);
      for (const block of message.content) {
        if (block.type === "toolCall") toolCalls.set(block.id, { stage: event.stage, variant: event.variant, call: block });
      }
      return;
    }

    if (message.role === "toolResult") {
      const pending = toolCalls.get(message.toolCallId);
      const call = pending?.call ?? fallbackToolCall(message);
      console.log(`  ${summarizeTool(call, message)}`);
      return;
    }

    if (message.role === "bashExecution") {
      console.log(`  bash   ${message.command}  ${message.exitCode === 0 ? "pass" : `fail exit=${message.exitCode ?? "?"}`}`);
      if (message.exitCode !== 0) console.log(indent(lastLines(message.output, FAILURE_OUTPUT_LINES), "    "));
    }
  };
}

function summarizeTool(call: ToolCall, result: ToolResultMessage): string {
  const tool = (result.toolName || call.name).padEnd(6);
  const target = summarizeTarget(call);
  const status = result.isError ? "fail" : "pass";
  if (call.name === "subagent") return `${tool} ${summarizeSubagentResult(result)}  ${status}`;
  return `${tool} ${target}${target ? "  " : ""}${status}`;
}

function summarizeTarget(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "read" || call.name === "edit" || call.name === "write") return compact(String(args.path ?? ""));
  if (call.name === "bash") return compact(String(args.command ?? ""));
  if (call.name === "subagent") return summarizeSubagentCall(call);
  return "";
}

function summarizeSubagentCall(call: ToolCall): string {
  const args = call.arguments ?? {};
  const tasks = Array.isArray(args.tasks) ? args.tasks.length : Array.isArray(args.chain) ? args.chain.length : typeof args.agent === "string" ? 1 : 0;
  const mode = Array.isArray(args.chain) ? "chain" : Array.isArray(args.tasks) ? "parallel" : typeof args.action === "string" ? args.action : "single";
  return `${mode} (${tasks})`;
}

function summarizeSubagentResult(result: ToolResultMessage): string {
  const details = (result.details ?? {}) as { results?: Array<{ exitCode?: number; error?: string }> };
  const results = details.results ?? [];
  if (results.length === 0) return "subagent";
  const ok = results.filter((worker) => worker.exitCode === 0 || (!worker.error && worker.exitCode === undefined)).length;
  const failed = results.length - ok;
  return `${ok}/${results.length} ok${failed > 0 ? `, ${failed} failed` : ""}`;
}

function fallbackToolCall(message: ToolResultMessage): ToolCall {
  return { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} };
}

function addUsageToMap(map: Map<string, UsageTotals>, key: string, usage: Usage): void {
  const current = map.get(key) ?? emptyUsage();
  map.set(key, {
    totalTokens: current.totalTokens + usage.totalTokens,
    costTotal: current.costTotal + usage.cost.total,
  });
}

function emptyUsage(): UsageTotals {
  return { totalTokens: 0, costTotal: 0 };
}

function formatStage(stage: StageName, variant?: number): string {
  return variant === undefined ? stage : `${stage}#${variant}`;
}

function stageKey(stage: StageName, variant?: number): string {
  return `${stage}:${variant ?? ""}`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "--";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(4)}` : "$0.00";
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TARGET_CHARS ? `${oneLine.slice(0, MAX_TARGET_CHARS - 1)}…` : oneLine;
}

function lastLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n");
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
