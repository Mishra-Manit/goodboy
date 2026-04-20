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
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { attachJsonlReader } from "./jsonl-reader.js";

const log = createLogger("pi-rpc");

const KILL_GRACE_MS = 2000;

// --- Public types ---

interface PiEvent {
  type: string;
  [key: string]: unknown;
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
      case "extension_ui_request": return handleUiRequest(event, proc);
      case "agent_end":             return completeOnce();
      case "response":              return logFailedResponse(id, event);
    }
  }

  attachJsonlReader(proc.stdout!, (line) => {
    try { handleEvent(JSON.parse(line) as PiEvent); }
    catch { /* non-JSON line; pi occasionally emits banners -- ignore */ }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
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
      proc.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
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
      try { proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n"); }
      catch { /* stdin may already be closed */ }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      }, KILL_GRACE_MS);
      proc.once("exit", () => clearTimeout(killTimer));
    },
  };
}

// --- Pure helpers ---

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
function handleUiRequest(event: PiEvent, proc: ChildProcess): void {
  const method = event.method as string;
  const reqId = event.id as string;
  if (!["select", "confirm", "input", "editor"].includes(method)) return;
  const response = method === "confirm"
    ? { type: "extension_ui_response", id: reqId, confirmed: true }
    : { type: "extension_ui_response", id: reqId, cancelled: true };
  proc.stdin!.write(JSON.stringify(response) + "\n");
}

function logFailedResponse(id: string, event: PiEvent): void {
  if (event.success) return;
  log.warn(`[${id}] Command ${String(event.command)} failed: ${String(event.error)}`);
}
