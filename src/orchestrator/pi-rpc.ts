import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import type { PiOutputMarker } from "../shared/types.js";

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
  onLogLine?: (line: string) => void;
}): PiSession {
  const { id, cwd, systemPrompt, model, onEvent, onLogLine } = options;

  const args = ["--mode", "rpc"];
  if (model) {
    args.push("--model", model);
  }

  log.info(`Spawning pi session ${id} in ${cwd}`);

  const proc = spawn(config.piCommand, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_SYSTEM_PROMPT: systemPrompt,
    },
  });

  let buffer = "";
  const allEvents: PiEvent[] = [];
  let fullOutput = "";
  let resolveCompletion: ((result: {
    marker: PiOutputMarker | null;
    fullOutput: string;
    events: PiEvent[];
  }) => void) | null = null;

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      onLogLine?.(line);

      try {
        const event = JSON.parse(line) as PiEvent;
        allEvents.push(event);
        onEvent?.(event);

        if (event.type === "agent_end") {
          const text = (event.text as string) ?? "";
          fullOutput += text;
        }

        if (event.type === "message_update") {
          const text = (event.text as string) ?? "";
          fullOutput = text; // message_update replaces full text
        }
      } catch {
        // Not JSON — treat as raw log line
        fullOutput += line + "\n";
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onLogLine?.(text);
    log.debug(`[${id} stderr] ${text.trim()}`);
  });

  proc.on("exit", (code) => {
    log.info(`Pi session ${id} exited with code ${code}`);
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
      const command = JSON.stringify({ type: "prompt", text: message });
      proc.stdin?.write(command + "\n");
      log.debug(`Sent prompt to session ${id}`);
    },

    waitForCompletion() {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          const marker = extractMarker(fullOutput);
          resolve({ marker, fullOutput, events: allEvents });
          return;
        }
        resolveCompletion = resolve;
      });
    },

    kill() {
      proc.kill("SIGTERM");
    },
  };
}

/**
 * Extract the structured JSON marker from the end of pi output.
 */
function extractMarker(text: string): PiOutputMarker | null {
  // Look for the last JSON object in the output
  const jsonPattern = /\{[^{}]*"status"\s*:\s*"(?:needs_input|complete|ready)"[^{}]*\}/g;
  const matches = text.match(jsonPattern);
  if (!matches || matches.length === 0) return null;

  try {
    return JSON.parse(matches[matches.length - 1]) as PiOutputMarker;
  } catch {
    return null;
  }
}
