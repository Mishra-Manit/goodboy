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
  waitForExit: () => Promise<void>;
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
  let resolveExit: (() => void) | null = null;
  let textLineBuffer = "";
  let suppressExitLog = false;

  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  /** Track active tool calls for duration measurement */
  const activeTools = new Map<string, number>(); // toolCallId -> startTime

  function emitLog(kind: LogEntryKind, text: string, meta?: Record<string, unknown>): void {
    onLog?.(kind, text, meta);
  }

  const subagentCoalescer = createSubagentCoalescer(emitLog);

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

  proc.on("exit", (code, signal) => {
    log.info(`Pi session ${id} exited with code ${code}`);
    if (!suppressExitLog) {
      const exitText = signal
        ? `Process exited via signal ${signal}`
        : `Process exited with code ${code}`;
      emitLog("stage_info", exitText);
    }
    // If the process exits before agent_end, resolve with what we have
    if (resolveCompletion) {
      resolveCompletion({ marker: extractMarker(fullOutput), fullOutput });
      resolveCompletion = null;
      rejectCompletion = null;
    }
    resolveExit?.();
    resolveExit = null;
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

    waitForExit() {
      if (proc.exitCode !== null) {
        return Promise.resolve();
      }
      return exitPromise;
    },

    kill() {
      if (resolveCompletion === null && rejectCompletion === null) {
        suppressExitLog = true;
      }
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
