import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import type { PiOutputMarker, LogEntryKind } from "../shared/types.js";
import { createSubagentCoalescer } from "./rpc-coalesce.js";

const log = createLogger("pi-rpc");

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiSession {
  id: string;
  process: ChildProcess;
  sendPrompt: (message: string) => void;
  waitForCompletion: () => Promise<{
    marker: PiOutputMarker | null;
    fullOutput: string;
  }>;
  kill: () => void;
}

/**
 * Spawn a pi instance in RPC mode and return a session handle.
 */
export function spawnPiSession(options: {
  id: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  onEvent?: (event: PiEvent) => void;
  /** Resume or create a persistent session file */
  sessionPath?: string;
  /** Structured log callback */
  onLog?: (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;
  /**
   * Explicit extension paths to load. Discovery stays disabled via
   * --no-extensions; each path is passed with -e. Default is no extensions.
   */
  extensions?: string[];
  /** Additional environment variables merged on top of process.env. */
  envOverrides?: Record<string, string>;
}): PiSession {
  const { id, cwd, systemPrompt, model, sessionPath, onEvent, onLog, extensions, envOverrides } = options;

  const args = [
    "--mode", "rpc",
    ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
    "--no-extensions",
    ...(extensions?.flatMap((p) => ["-e", p]) ?? []),
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt", systemPrompt,
  ];
  if (model) {
    args.push("--model", model);
  }

  log.info(`Spawning pi session ${id} in ${cwd}${extensions?.length ? ` with extensions: ${extensions.join(", ")}` : ""}`);

  const proc = spawn(config.piCommand, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(envOverrides ?? {}) },
  });

  let fullOutput = "";
  let resolveCompletion: ((result: { marker: PiOutputMarker | null; fullOutput: string }) => void) | null = null;
  let rejectCompletion: ((err: Error) => void) | null = null;
  let textLineBuffer = "";

  /** Track active tool calls for duration measurement */
  const activeTools = new Map<string, number>(); // toolCallId -> startTime

  function emitLog(kind: LogEntryKind, text: string, meta?: Record<string, unknown>): void {
    onLog?.(kind, text, meta);
  }

  const subagentCoalescer = createSubagentCoalescer(emitLog);

  // Proper JSONL reader -- split only on \n, not Unicode line separators
  function attachJsonlReader(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void
  ): void {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) onLine(line);
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) {
        onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
    });
  }

  function handleEvent(event: PiEvent): void {
    onEvent?.(event);

    // Auto-respond to extension UI dialog requests
    if (event.type === "extension_ui_request") {
      const method = event.method as string;
      const reqId = event.id as string;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        const response = method === "confirm"
          ? { type: "extension_ui_response", id: reqId, confirmed: true }
          : { type: "extension_ui_response", id: reqId, cancelled: true };
        proc.stdin!.write(JSON.stringify(response) + "\n");
      }
      return;
    }

    if (event.type === "agent_start") {
      emitLog("stage_info", "Agent started");
    }

    // Collect text from streaming deltas -- buffer into complete lines
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta") {
        const text = delta.delta as string;
        fullOutput += text;
        textLineBuffer += text;
        // Emit complete lines only
        const lines = textLineBuffer.split("\n");
        textLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() && !isRawToolEvent(line.trim())) emitLog("text", line);
        }
      }
    }

    // Tool execution logging -- structured
    if (event.type === "tool_execution_start") {
      const toolName = event.toolName as string;
      const toolCallId = (event.toolCallId as string) ?? toolName;
      const args = event.args as Record<string, unknown> | undefined;

      activeTools.set(toolCallId, Date.now());

      if (toolName === "subagent") {
        emitSubagentStart(toolCallId, args, emitLog);
      } else {
        let summary: string;
        if (toolName === "bash") {
          const cmd = (args?.command as string) ?? "";
          summary = cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd;
        } else if (["read", "edit", "write"].includes(toolName)) {
          summary = (args?.path as string) ?? "";
        } else {
          summary = toolName;
        }
        emitLog("tool_start", summary, {
          tool: toolName,
          toolCallId,
          args: args ? truncateArgs(args) : undefined,
        });
      }
    }

    // Streaming progress from long-running tools. Only subagent is subscribed
    // for v1 -- built-in tools rarely have useful mid-execution state.
    if (event.type === "tool_execution_update") {
      const toolName = event.toolName as string;
      if (toolName !== "subagent") return;
      const toolCallId = (event.toolCallId as string) ?? toolName;
      subagentCoalescer.push(toolCallId, event.partialResult);
    }

    if (event.type === "tool_execution_end") {
      const toolName = event.toolName as string;
      const toolCallId = (event.toolCallId as string) ?? toolName;
      const isError = event.isError as boolean;
      const result = event.result;

      const startTime = activeTools.get(toolCallId);
      const durationMs = startTime ? Date.now() - startTime : undefined;
      activeTools.delete(toolCallId);

      if (toolName === "subagent") {
        subagentCoalescer.end(toolCallId);
        emitSubagentEnd(toolCallId, result, isError, durationMs, emitLog);
        return;
      }

      emitLog("tool_end", `${toolName} ${isError ? "FAILED" : "done"}`, {
        tool: toolName,
        toolCallId,
        ok: !isError,
        durationMs,
      });

      // Emit truncated tool output for visibility
      const resultStr = typeof result === "string" ? result : undefined;
      if (resultStr && resultStr.trim().length > 0) {
        const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + `... (${resultStr.length} chars)` : resultStr;
        emitLog("tool_output", truncated, { tool: toolName, toolCallId });
      }
    }

    // Agent finished -- flush remaining text buffer and resolve
    if (event.type === "agent_end") {
      if (textLineBuffer.trim()) {
        emitLog("text", textLineBuffer);
        textLineBuffer = "";
      }
      emitLog("stage_info", "Agent finished");
      if (resolveCompletion) {
        resolveCompletion({ marker: extractMarker(fullOutput), fullOutput });
        resolveCompletion = null;
        rejectCompletion = null;
      }
    }

    // Command response logging
    if (event.type === "response") {
      const success = event.success as boolean;
      const cmd = event.command as string;
      if (!success) {
        const error = event.error as string;
        log.warn(`[${id}] Command ${cmd} failed: ${error}`);
        emitLog("rpc", `Command ${cmd} failed: ${error}`);
      }
    }
  }

  attachJsonlReader(proc.stdout!, (line) => {
    try {
      const event = JSON.parse(line) as PiEvent;
      handleEvent(event);
    } catch {
      // Not JSON -- raw log line
      emitLog("text", line);
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      emitLog("stderr", text);
      log.debug(`[${id} stderr] ${text}`);
    }
  });

  proc.on("exit", (code) => {
    log.info(`Pi session ${id} exited with code ${code}`);
    emitLog("stage_info", `Process exited with code ${code}`);
    // If the process exits before agent_end, resolve with what we have
    if (resolveCompletion) {
      resolveCompletion({ marker: extractMarker(fullOutput), fullOutput });
      resolveCompletion = null;
      rejectCompletion = null;
    }
  });

  return {
    id,
    process: proc,

    sendPrompt(message: string) {
      // Reset output for this new prompt so waitForCompletion gets fresh data
      fullOutput = "";
      const command = JSON.stringify({ type: "prompt", message });
      proc.stdin!.write(command + "\n");
      log.debug(`Sent prompt to session ${id}`);
      emitLog("rpc", "Prompt sent");
    },

    waitForCompletion() {
      if (resolveCompletion) {
        throw new Error(`[${id}] waitForCompletion called while already waiting`);
      }
      return new Promise((resolve, reject) => {
        if (proc.exitCode !== null) {
          resolve({ marker: extractMarker(fullOutput), fullOutput });
          return;
        }
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
    },

    kill() {
      if (rejectCompletion) {
        rejectCompletion(new Error("Session killed"));
        rejectCompletion = null;
        resolveCompletion = null;
      }
      subagentCoalescer.flushAll();
      try {
        proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {
        // stdin may be closed
      }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      }, 2000);
      proc.once("exit", () => clearTimeout(killTimer));
    },
  };
}

// ---------------------------------------------------------------------------
// Subagent-specific emit helpers
// ---------------------------------------------------------------------------

type EmitLog = (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;

/** Max bytes of a single worker's finalOutput we persist; plenty for our rigid
 *  Finding/Evidence/Caveats format which is typically <2KB. */
const SUBAGENT_OUTPUT_CAP = 8192;

function emitSubagentStart(
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

function emitSubagentEnd(
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

function parseSubagentDetails(result: unknown): { results: SubagentWorkerResult[] } | null {
  if (!result) return null;
  // pi-subagents returns a structured Details object directly; some pi
  // versions wrap it as a JSON string inside the tool result envelope.
  if (typeof result === "object") {
    const obj = result as { results?: SubagentWorkerResult[] };
    if (Array.isArray(obj.results)) return { results: obj.results };
  }
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (parsed && Array.isArray(parsed.results)) return { results: parsed.results };
    } catch { /* not JSON */ }
  }
  return null;
}

/** Detect raw tool event JSON that leaks into the text stream (duplicates structured entries) */
function isRawToolEvent(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const obj = JSON.parse(text);
    return (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.type === "string" &&
      (obj.type === "tool_execution_end" ||
        obj.type === "tool_execution_start" ||
        obj.type === "tool_call")
    );
  } catch {
    return false;
  }
}

/** Truncate argument values for display */
function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 300) {
      result[key] = value.slice(0, 300) + "...";
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the structured JSON marker from the end of pi output.
 * Uses line-based parsing to avoid regex false-positives.
 */
function extractMarker(text: string): PiOutputMarker | null {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.status === "complete") {
        return parsed as PiOutputMarker;
      }
    } catch { /* not JSON */ }
  }
  return null;
}
