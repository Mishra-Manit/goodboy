import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import type { PiOutputMarker, LogEntry, LogEntryKind } from "../shared/types.js";

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
    events: PiEvent[];
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
  /** Structured log callback -- use this instead of onLogLine */
  onLog?: (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => void;
  /** @deprecated use onLog for structured logging */
  onLogLine?: (line: string) => void;
}): PiSession {
  const { id, cwd, systemPrompt, model, onEvent, onLog, onLogLine } = options;

  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt", systemPrompt,
  ];
  if (model) {
    args.push("--model", model);
  }

  log.info(`Spawning pi session ${id} in ${cwd}`);

  const proc = spawn(config.piCommand, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const allEvents: PiEvent[] = [];
  let fullOutput = "";
  let resolveCompletion: ((result: {
    marker: PiOutputMarker | null;
    fullOutput: string;
    events: PiEvent[];
  }) => void) | null = null;
  let agentRunning = false;
  let textLineBuffer = "";

  /** Track active tool calls for duration measurement */
  const activeTools = new Map<string, number>(); // toolCallId -> startTime

  function emitLog(kind: LogEntryKind, text: string, meta?: Record<string, unknown>): void {
    onLog?.(kind, text, meta);
    onLogLine?.(text);
  }

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
    allEvents.push(event);
    onEvent?.(event);

    // Auto-respond to extension UI dialog requests
    if (event.type === "extension_ui_request") {
      const method = event.method as string;
      const reqId = event.id as string;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        const response = method === "confirm"
          ? { type: "extension_ui_response", id: reqId, confirmed: true }
          : { type: "extension_ui_response", id: reqId, cancelled: true };
        proc.stdin?.write(JSON.stringify(response) + "\n");
      }
      return;
    }

    if (event.type === "agent_start") {
      agentRunning = true;
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
          if (line.trim()) emitLog("text", line);
        }
      }
    }

    // Tool execution logging -- structured
    if (event.type === "tool_execution_start") {
      const toolName = event.toolName as string;
      const toolCallId = (event.toolCallId as string) ?? toolName;
      const args = event.args as Record<string, unknown> | undefined;

      activeTools.set(toolCallId, Date.now());

      // Build a readable summary for the text field
      let summary: string;
      if (toolName === "bash") {
        const cmd = (args?.command as string) ?? "";
        summary = cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd;
      } else if (toolName === "read") {
        summary = (args?.path as string) ?? "";
      } else if (toolName === "edit") {
        summary = (args?.path as string) ?? "";
      } else if (toolName === "write") {
        summary = (args?.path as string) ?? "";
      } else {
        summary = toolName;
      }

      emitLog("tool_start", summary, {
        tool: toolName,
        args: args ? truncateArgs(args) : undefined,
      });
    }

    if (event.type === "tool_execution_end") {
      const toolName = event.toolName as string;
      const toolCallId = (event.toolCallId as string) ?? toolName;
      const isError = event.isError as boolean;
      const result = event.result as string | undefined;

      const startTime = activeTools.get(toolCallId);
      const durationMs = startTime ? Date.now() - startTime : undefined;
      activeTools.delete(toolCallId);

      emitLog("tool_end", `${toolName} ${isError ? "FAILED" : "done"}`, {
        tool: toolName,
        ok: !isError,
        durationMs,
      });

      // Emit truncated tool output for visibility
      if (result && result.trim().length > 0) {
        const truncated = result.length > 500 ? result.slice(0, 500) + `... (${result.length} chars)` : result;
        emitLog("tool_output", truncated, { tool: toolName });
      }
    }

    // Agent finished -- flush remaining text buffer and resolve
    if (event.type === "agent_end") {
      if (textLineBuffer.trim()) {
        emitLog("text", textLineBuffer);
        textLineBuffer = "";
      }
      emitLog("stage_info", "Agent finished");
      agentRunning = false;
      if (resolveCompletion) {
        const marker = extractMarker(fullOutput);
        resolveCompletion({ marker, fullOutput, events: [...allEvents] });
        resolveCompletion = null;
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

  proc.stderr?.on("data", (chunk: Buffer) => {
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
      const marker = extractMarker(fullOutput);
      resolveCompletion({ marker, fullOutput, events: allEvents });
      resolveCompletion = null;
    }
  });

  return {
    id,
    process: proc,

    sendPrompt(message: string) {
      // Reset output for this new prompt so waitForCompletion gets fresh data
      fullOutput = "";
      const command = JSON.stringify({ type: "prompt", message });
      proc.stdin?.write(command + "\n");
      log.debug(`Sent prompt to session ${id}`);
      emitLog("rpc", "Prompt sent");
    },

    waitForCompletion() {
      return new Promise((resolve) => {
        // If process already exited, resolve immediately
        if (proc.exitCode !== null) {
          const marker = extractMarker(fullOutput);
          resolve({ marker, fullOutput, events: [...allEvents] });
          return;
        }
        // Otherwise wait for the next agent_end event
        resolveCompletion = resolve;
      });
    },

    kill() {
      // Try graceful abort first
      try {
        proc.stdin?.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {
        // stdin may be closed
      }
      setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill("SIGTERM");
        }
      }, 2000);
    },
  };
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
 */
function extractMarker(text: string): PiOutputMarker | null {
  const jsonPattern = /\{[^{}]*"status"\s*:\s*"(?:needs_input|complete|ready)"[^{}]*\}/g;
  const matches = text.match(jsonPattern);
  if (!matches || matches.length === 0) return null;

  try {
    return JSON.parse(matches[matches.length - 1]) as PiOutputMarker;
  } catch {
    return null;
  }
}
