/**
 * Spawn a `pi --mode rpc` subprocess and return a `PiSession` handle. Owns
 * stdout parsing, tool-event routing, subagent coalescing, and the kill path.
 * The pure helpers in the sibling files (`marker`, `tool-filters`,
 * `jsonl-reader`, `subagents`, `rpc-coalesce`) do the real parsing; this file
 * is the IO glue.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import type { PiOutputMarker, LogEntryKind } from "../../shared/types.js";
import { createSubagentCoalescer } from "./rpc-coalesce.js";
import { attachJsonlReader } from "./jsonl-reader.js";
import { extractMarker } from "./marker.js";
import { isRawToolEvent, truncateArgs } from "./tool-filters.js";
import { emitSubagentStart, emitSubagentEnd } from "./subagents.js";

const log = createLogger("pi-rpc");

const KILL_GRACE_MS = 2000;
const TOOL_OUTPUT_CAP = 500;
const BASH_SUMMARY_CAP = 200;

// --- Public types ---

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export type EmitLog = (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;

export interface PiSession {
  id: string;
  process: ChildProcess;
  sendPrompt: (message: string) => void;
  waitForCompletion: () => Promise<{ marker: PiOutputMarker | null; fullOutput: string }>;
  waitForExit: () => Promise<void>;
  kill: () => void;
}

interface SpawnOptions {
  id: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  onEvent?: (event: PiEvent) => void;
  /** Resume or create a persistent session file. */
  sessionPath?: string;
  /** Structured log callback. */
  onLog?: EmitLog;
  /** Explicit extension paths to load with `-e`; discovery stays off via `--no-extensions`. */
  extensions?: string[];
  /** Extra env vars merged on top of `process.env`. */
  envOverrides?: Record<string, string>;
}

// --- Public API ---

/** Spawn a pi RPC subprocess; returns a handle that streams events and resolves on agent end or exit. */
export function spawnPiSession(options: SpawnOptions): PiSession {
  const { id, cwd, systemPrompt, model, sessionPath, onEvent, onLog, extensions, envOverrides } = options;

  log.info(
    `Spawning pi session ${id} in ${cwd}` +
    (extensions?.length ? ` with extensions: ${extensions.join(", ")}` : ""),
  );
  const proc = spawn(config.piCommand, buildPiArgs({ sessionPath, extensions, systemPrompt, model }), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(envOverrides ?? {}) },
  });

  // Mutable state owned by this session.
  let fullOutput = "";
  let textLineBuffer = "";
  let suppressExitLog = false;
  let resolveCompletion: ((r: { marker: PiOutputMarker | null; fullOutput: string }) => void) | null = null;
  let rejectCompletion: ((err: Error) => void) | null = null;
  let resolveExit: (() => void) | null = null;
  const activeTools = new Map<string, number>(); // toolCallId -> startTime

  const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
  const emitLog: EmitLog = (kind, text, meta) => onLog?.(kind, text, meta);
  const subagentCoalescer = createSubagentCoalescer(emitLog);

  function resolveNow(): void {
    if (!resolveCompletion) return;
    resolveCompletion({ marker: extractMarker(fullOutput), fullOutput });
    resolveCompletion = null;
    rejectCompletion = null;
  }

  function handleEvent(event: PiEvent): void {
    onEvent?.(event);
    switch (event.type) {
      case "extension_ui_request":    return handleUiRequest(event, proc);
      case "agent_start":             return emitLog("stage_info", "Agent started");
      case "message_update":          return handleMessageUpdate(event);
      case "tool_execution_start":    return handleToolStart(event);
      case "tool_execution_update":   return handleToolUpdate(event);
      case "tool_execution_end":      return handleToolEnd(event);
      case "agent_end":               return handleAgentEnd();
      case "response":                return handleResponse(event);
    }
  }

  function handleMessageUpdate(event: PiEvent): void {
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (delta?.type !== "text_delta") return;
    const text = delta.delta as string;
    fullOutput += text;
    textLineBuffer += text;
    // Emit complete lines only; the last (partial) chunk stays buffered.
    const lines = textLineBuffer.split("\n");
    textLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() && !isRawToolEvent(line.trim())) emitLog("text", line);
    }
  }

  function handleToolStart(event: PiEvent): void {
    const toolName = event.toolName as string;
    const toolCallId = (event.toolCallId as string) ?? toolName;
    const args = event.args as Record<string, unknown> | undefined;
    activeTools.set(toolCallId, Date.now());

    if (toolName === "subagent") {
      emitSubagentStart(toolCallId, args, emitLog);
      return;
    }
    emitLog("tool_start", toolStartSummary(toolName, args), {
      tool: toolName,
      toolCallId,
      args: args ? truncateArgs(args) : undefined,
    });
  }

  // Only subagent streams useful mid-execution state; built-in tools are ignored.
  function handleToolUpdate(event: PiEvent): void {
    if (event.toolName !== "subagent") return;
    const toolCallId = (event.toolCallId as string) ?? "subagent";
    subagentCoalescer.push(toolCallId, event.partialResult);
  }

  function handleToolEnd(event: PiEvent): void {
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
      tool: toolName, toolCallId, ok: !isError, durationMs,
    });
    if (typeof result === "string" && result.trim().length > 0) {
      const capped = result.length > TOOL_OUTPUT_CAP
        ? `${result.slice(0, TOOL_OUTPUT_CAP)}... (${result.length} chars)`
        : result;
      emitLog("tool_output", capped, { tool: toolName, toolCallId });
    }
  }

  function handleAgentEnd(): void {
    if (textLineBuffer.trim()) emitLog("text", textLineBuffer);
    textLineBuffer = "";
    emitLog("stage_info", "Agent finished");
    resolveNow();
  }

  function handleResponse(event: PiEvent): void {
    if (event.success) return;
    const cmd = event.command as string;
    const error = event.error as string;
    log.warn(`[${id}] Command ${cmd} failed: ${error}`);
    emitLog("rpc", `Command ${cmd} failed: ${error}`);
  }

  // --- Wire up stdio and process lifecycle ---

  attachJsonlReader(proc.stdout!, (line) => {
    try {
      handleEvent(JSON.parse(line) as PiEvent);
    } catch {
      emitLog("text", line); // Not JSON; treat as raw log output.
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    emitLog("stderr", text);
    log.debug(`[${id} stderr] ${text}`);
  });

  proc.on("exit", (code, signal) => {
    log.info(`Pi session ${id} exited with code ${code}`);
    if (!suppressExitLog) {
      emitLog("stage_info", signal
        ? `Process exited via signal ${signal}`
        : `Process exited with code ${code}`);
    }
    resolveNow(); // If process exits before agent_end, resolve with what we have.
    resolveExit?.();
    resolveExit = null;
  });

  // --- Handle returned to caller ---

  return {
    id,
    process: proc,

    sendPrompt(message: string) {
      // Reset so waitForCompletion gets fresh data for this prompt.
      fullOutput = "";
      proc.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
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

    waitForExit() {
      return proc.exitCode !== null ? Promise.resolve() : exitPromise;
    },

    kill() {
      const wasIdle = resolveCompletion === null && rejectCompletion === null;
      if (wasIdle) suppressExitLog = true;
      if (rejectCompletion) {
        rejectCompletion(new Error("Session killed"));
        rejectCompletion = null;
        resolveCompletion = null;
      }
      subagentCoalescer.flushAll();
      try {
        proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch { /* stdin may be closed */ }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      }, KILL_GRACE_MS);
      proc.once("exit", () => clearTimeout(killTimer));
    },
  };
}

// --- Pure helpers ---

function buildPiArgs(opts: {
  sessionPath?: string;
  extensions?: string[];
  systemPrompt: string;
  model?: string;
}): string[] {
  return [
    "--mode", "rpc",
    ...(opts.sessionPath ? ["--session", opts.sessionPath] : ["--no-session"]),
    "--no-extensions",
    ...(opts.extensions?.flatMap((p) => ["-e", p]) ?? []),
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt", opts.systemPrompt,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

function toolStartSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (toolName === "bash") {
    const cmd = (args?.command as string) ?? "";
    return cmd.length > BASH_SUMMARY_CAP ? `${cmd.slice(0, BASH_SUMMARY_CAP)}...` : cmd;
  }
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    return (args?.path as string) ?? "";
  }
  return toolName;
}

function handleUiRequest(event: PiEvent, proc: ChildProcess): void {
  const method = event.method as string;
  const reqId = event.id as string;
  if (!["select", "confirm", "input", "editor"].includes(method)) return;
  const response = method === "confirm"
    ? { type: "extension_ui_response", id: reqId, confirmed: true }
    : { type: "extension_ui_response", id: reqId, cancelled: true };
  proc.stdin!.write(JSON.stringify(response) + "\n");
}
