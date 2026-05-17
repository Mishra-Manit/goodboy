/** Parse delegated subagent tool calls from a parent pi session. */

import type { FileEntry, ToolCall, ToolResultMessage } from "../../shared/contracts/session.js";

export interface ParsedSubagentRun {
  agentName: string;
  runIndex: number | null;
  prompt: string;
  resultText: string | null;
  status: "complete" | "failed";
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  costUsd: string | null;
  toolCallCount: number | null;
}

/** Extract best-effort subagent run rows from parent session tool calls/results. */
export function parseSubagentRuns(entries: readonly FileEntry[]): ParsedSubagentRun[] {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }

  const runs: ParsedSubagentRun[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const calls = entry.message.content.filter((block): block is ToolCall => (
      block.type === "toolCall" && block.name === "subagent"
    ));
    for (const call of calls) {
      const result = results.get(call.id) ?? null;
      runs.push(...parseSubagentCall(call, result));
    }
  }
  return runs;
}

function parseSubagentCall(call: ToolCall, result: ToolResultMessage | null): ParsedSubagentRun[] {
  const tasks = normalizeTasks(call.arguments);
  if (tasks.length === 0) {
    return [buildRun({ agentName: "subagent", prompt: JSON.stringify(call.arguments), runIndex: null, result })];
  }
  return tasks.map((task, index) => buildRun({
    agentName: task.agentName,
    prompt: task.prompt,
    runIndex: index,
    result,
  }));
}

function buildRun(input: {
  agentName: string;
  prompt: string;
  runIndex: number | null;
  result: ToolResultMessage | null;
}): ParsedSubagentRun {
  return {
    agentName: input.agentName,
    runIndex: input.runIndex,
    prompt: input.prompt,
    resultText: input.result ? resultText(input.result) : null,
    status: input.result?.isError ? "failed" : "complete",
    model: null,
    durationMs: null,
    totalTokens: null,
    costUsd: null,
    toolCallCount: null,
  };
}

function normalizeTasks(args: Record<string, unknown>): Array<{ agentName: string; prompt: string }> {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  return rawTasks
    .map((task) => normalizeTask(task))
    .filter((task): task is { agentName: string; prompt: string } => task !== null);
}

function normalizeTask(task: unknown): { agentName: string; prompt: string } | null {
  if (!task || typeof task !== "object") return null;
  const record = task as Record<string, unknown>;
  const agentName = typeof record.agent === "string" ? record.agent : "subagent";
  const prompt = typeof record.task === "string"
    ? record.task
    : typeof record.prompt === "string" ? record.prompt : null;
  if (!prompt) return null;
  return { agentName, prompt };
}

function resultText(result: ToolResultMessage): string {
  const contentText = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (contentText) return contentText;
  return result.details === undefined ? "" : JSON.stringify(result.details);
}
