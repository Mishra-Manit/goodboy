/**
 * Spawn a `pi --mode rpc` subprocess. The returned handle lets callers send
 * a prompt, wait for `agent_end`, and kill the process. We no longer route
 * pi's RPC events into our own log entries: pi writes its native session
 * JSONL to `sessionPath`, and downstream code tails that file instead.
 *
 * The only RPC events we still care about are `agent_end` (completion) and
 * `extension_ui_request` (auto-confirm so unattended runs don't hang).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../../shared/runtime/logger.js";
import { config } from "../../shared/runtime/config.js";
import { attachJsonlReader } from "./jsonl-reader.js";

const log = createLogger("pi-rpc");

const KILL_GRACE_MS = 2000;

// --- Public types ---

type PiEvent =
  | { type: "extension_ui_request"; id: string; method: string }
  | { type: "agent_end" }
  | { type: "response"; success?: boolean; command?: unknown; error?: unknown };

interface ProcessPipes {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}

export interface PiSession {
  id: string;
  process: ChildProcess;
  sendPrompt: (message: string) => void;
  /** Resolves on `agent_end` (or process exit, whichever comes first). */
  waitForCompletion: () => Promise<void>;
  waitForExit: () => Promise<void>;
  kill: () => void;
}

export interface SpawnOptions {
  id: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  /** Path to the pi session JSONL file. Required -- we rely on it for logs. */
  sessionPath: string;
  /** Explicit extension paths to load with `-e`. Discovery stays off. */
  extensions?: string[];
  /** Extra env vars merged on top of `process.env`. */
  envOverrides?: Record<string, string>;
}

// --- Public API ---

/** Spawn a pi RPC subprocess and return a handle. */
export function spawnPiSession(options: SpawnOptions): PiSession {
  const { id, cwd, systemPrompt, model, sessionPath, extensions, envOverrides } = options;

  log.info(
    `Spawning pi session ${id} in ${cwd}` +
    (extensions?.length ? ` with extensions: ${extensions.join(", ")}` : ""),
  );
  const proc = spawn(config.piCommand, buildPiArgs({ sessionPath, extensions, systemPrompt, model }), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(envOverrides ?? {}) },
  });
  const pipes = assertPipes(proc);

  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((err: Error) => void) | null = null;
  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });

  function completeOnce(): void {
    resolveCompletion?.();
    resolveCompletion = null;
    rejectCompletion = null;
  }

  function handleEvent(event: PiEvent): void {
    switch (event.type) {
      case "extension_ui_request": return handleUiRequest(event, pipes);
      case "agent_end":             return completeOnce();
      case "response":              return logFailedResponse(id, event);
    }
  }

  attachJsonlReader(pipes.stdout, (line) => {
    const event = parsePiEvent(line);
    if (event) handleEvent(event);
  });

  pipes.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.debug(`[${id} stderr] ${text}`);
  });

  proc.on("exit", (code) => {
    log.info(`Pi session ${id} exited with code ${code}`);
    completeOnce(); // If the process dies before agent_end, still release waiters.
    resolveExit?.();
    resolveExit = null;
  });

  return {
    id,
    process: proc,

    sendPrompt(message: string) {
      pipes.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
      log.debug(`Sent prompt to session ${id}`);
    },

    waitForCompletion() {
      if (resolveCompletion) throw new Error(`[${id}] waitForCompletion called while already waiting`);
      return new Promise((resolve, reject) => {
        if (proc.exitCode !== null) { resolve(); return; }
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
    },

    waitForExit() {
      return proc.exitCode !== null ? Promise.resolve() : exitPromise;
    },

    kill() {
      rejectCompletion?.(new Error("Session killed"));
      rejectCompletion = null;
      resolveCompletion = null;
      try { pipes.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); }
      catch { /* stdin may already be closed */ }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      }, KILL_GRACE_MS);
      proc.once("exit", () => clearTimeout(killTimer));
    },
  };
}

// --- Pure helpers ---

function assertPipes(proc: ChildProcess): ProcessPipes {
  const { stdin, stdout, stderr } = proc;
  if (!stdin || !stdout || !stderr) {
    throw new Error("Expected pi subprocess stdio pipes to be available");
  }
  return { stdin, stdout, stderr };
}

function parsePiEvent(line: string): PiEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
  const event = parsed as Record<string, unknown>;
  if (event.type === "agent_end") return { type: "agent_end" };
  if (event.type === "response") {
    return {
      type: "response",
      ...(typeof event.success === "boolean" ? { success: event.success } : {}),
      ...(event.command !== undefined ? { command: event.command } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    };
  }
  if (event.type === "extension_ui_request" && typeof event.id === "string" && typeof event.method === "string") {
    return { type: "extension_ui_request", id: event.id, method: event.method };
  }
  return null;
}

function buildPiArgs(opts: {
  sessionPath: string;
  extensions?: string[];
  systemPrompt: string;
  model?: string;
}): string[] {
  return [
    "--mode", "rpc",
    "--session", opts.sessionPath,
    "--no-extensions",
    ...(opts.extensions?.flatMap((p) => ["-e", p]) ?? []),
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt", opts.systemPrompt,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

/**
 * Auto-respond to extension UI prompts (select/confirm/input/editor) so
 * unattended pi sessions don't hang waiting for human input.
 */
function handleUiRequest(event: Extract<PiEvent, { type: "extension_ui_request" }>, pipes: ProcessPipes): void {
  if (!["select", "confirm", "input", "editor"].includes(event.method)) return;
  const response = event.method === "confirm"
    ? { type: "extension_ui_response", id: event.id, confirmed: true }
    : { type: "extension_ui_response", id: event.id, cancelled: true };
  pipes.stdin.write(JSON.stringify(response) + "\n");
}

function logFailedResponse(id: string, event: Extract<PiEvent, { type: "response" }>): void {
  if (event.success) return;
  log.warn(`[${id}] Command ${String(event.command)} failed: ${String(event.error)}`);
}
