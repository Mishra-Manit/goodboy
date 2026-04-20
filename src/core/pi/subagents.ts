import type { LogEntryKind } from "../../shared/types.js";

/**
 * Subagent-specific emit helpers.
 *
 * The `subagent` tool has a richer result shape than ordinary tools --
 * it can run parallel workers, each with its own finalOutput, usage, and
 * progress. Keeping this logic out of the generic event router keeps the
 * router simple and makes these parsers testable in isolation.
 */

type EmitLog = (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;

/** Max bytes of a single worker's finalOutput we persist; plenty for our rigid
 *  Finding/Evidence/Caveats format which is typically <2KB. */
const SUBAGENT_OUTPUT_CAP = 8192;

export function emitSubagentStart(
  toolCallId: string,
  args: Record<string, unknown> | undefined,
  emitLog: EmitLog,
): void {
  const tasks = extractSubagentTasks(args);
  const mode: string =
    Array.isArray((args as { chain?: unknown })?.chain) ? "chain"
    : Array.isArray((args as { tasks?: unknown })?.tasks) ? "parallel"
    : typeof (args as { action?: unknown })?.action === "string" ? "management"
    : "single";

  const taskCount = tasks.length;
  const text =
    mode === "parallel" ? `subagent \u00b7 parallel (${taskCount} tasks)`
    : mode === "chain" ? `subagent \u00b7 chain (${taskCount})`
    : mode === "management" ? `subagent \u00b7 ${String((args as { action?: unknown })?.action)}`
    : `subagent \u00b7 ${tasks[0]?.agent ?? "?"}`;

  emitLog("tool_start", text, {
    tool: "subagent",
    toolCallId,
    mode,
    taskCount,
    tasks,
  });
}

export function emitSubagentEnd(
  toolCallId: string,
  rawResult: unknown,
  isError: boolean,
  durationMs: number | undefined,
  emitLog: EmitLog,
): void {
  const details = parseSubagentDetails(rawResult);
  const results = details?.results ?? [];

  let completedCount = 0;
  let failedCount = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;

  // Emit one tool_output per worker, in workerIndex order.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ok = typeof r.exitCode === "number" ? r.exitCode === 0 : !r.error;
    if (ok) completedCount++;
    else failedCount++;
    if (r.usage) {
      totalTokensIn += Number(r.usage.input ?? 0);
      totalTokensOut += Number(r.usage.output ?? 0);
      totalCost += Number(r.usage.cost ?? 0);
    }

    const finalOutput = typeof r.finalOutput === "string" && r.finalOutput.length > 0
      ? r.finalOutput
      : (r.error ? `Error: ${r.error}` : "");
    const capped = finalOutput.length > SUBAGENT_OUTPUT_CAP
      ? finalOutput.slice(0, SUBAGENT_OUTPUT_CAP) + `... (${finalOutput.length} chars)`
      : finalOutput;

    emitLog("tool_output", capped, {
      tool: "subagent",
      toolCallId,
      workerIndex: i,
      agent: r.agent,
      task: trimTask(r.task),
      status: ok ? "completed" : "failed",
      tokens: r.usage ? Number(r.usage.input ?? 0) + Number(r.usage.output ?? 0) : undefined,
      durationMs: r.progress?.durationMs,
      error: r.error,
    });
  }

  const taskCount = results.length;
  const ok = !isError && failedCount === 0 && taskCount > 0;
  const text = taskCount > 0
    ? `subagent ${ok ? "done" : "done with errors"} (${completedCount}/${taskCount} ok)`
    : `subagent ${isError ? "FAILED" : "done"}`;

  emitLog("tool_end", text, {
    tool: "subagent",
    toolCallId,
    ok,
    durationMs,
    taskCount,
    completedCount,
    failedCount,
    totalTokensIn,
    totalTokensOut,
    totalCost,
  });
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

interface SubagentTaskSummary {
  agent: string;
  task: string;
}

function extractSubagentTasks(args: Record<string, unknown> | undefined): SubagentTaskSummary[] {
  if (!args) return [];
  if (Array.isArray(args.tasks)) {
    return args.tasks
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({ agent: String(t.agent ?? "?"), task: trimTask(t.task) }));
  }
  if (Array.isArray(args.chain)) {
    return args.chain
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({ agent: String(t.agent ?? "?"), task: trimTask(t.task) }));
  }
  if (typeof args.agent === "string") {
    return [{ agent: args.agent, task: trimTask(args.task) }];
  }
  return [];
}

function trimTask(task: unknown): string {
  if (typeof task !== "string") return "";
  return task.length > 200 ? task.slice(0, 200) + "..." : task;
}

interface SubagentWorkerResult {
  agent?: string;
  task?: string;
  exitCode?: number;
  error?: string;
  finalOutput?: string;
  usage?: { input?: number; output?: number; cost?: number };
  progress?: { durationMs?: number };
}

/**
 * Tool results from pi-agent-core are AgentToolResult objects: `{ content,
 * details, isError? }`. pi-subagents puts its parallel/chain results under
 * `details.results`. We also handle the top-level shape and stringified JSON
 * as defensive fallbacks for forward-compat with future pi versions.
 */
function parseSubagentDetails(result: unknown): { results: SubagentWorkerResult[] } | null {
  if (!result) return null;
  const tryShape = (obj: unknown): SubagentWorkerResult[] | null => {
    if (!obj || typeof obj !== "object") return null;
    const r = obj as {
      details?: { results?: SubagentWorkerResult[] };
      results?: SubagentWorkerResult[];
    };
    if (Array.isArray(r.details?.results)) return r.details!.results!;
    if (Array.isArray(r.results)) return r.results!;
    return null;
  };
  const direct = tryShape(result);
  if (direct) return { results: direct };
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      const fromJson = tryShape(parsed);
      if (fromJson) return { results: fromJson };
    } catch { /* not JSON */ }
  }
  return null;
}
