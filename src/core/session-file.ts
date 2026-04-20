/**
 * Read and tail pi's native session JSONL files. Pi writes one entry per
 * line (a `SessionHeader` followed by `SessionEntry` lines); we parse them
 * into typed objects and, when tailing, emit each newly appended line via
 * a callback. No seq counters, no write queues, no sort-on-read -- the file
 * is the source of truth and pi appends in order.
 */

import { mkdir, stat, readFile, open } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import { CURRENT_SESSION_VERSION, type FileEntry } from "../shared/session.js";
import type { StageName } from "../shared/types.js";

const log = createLogger("session-file");

const POLL_INTERVAL_MS = 500;

// --- Paths ---

/** Absolute path to a task stage's session file. */
export function taskSessionPath(taskId: string, stage: StageName): string {
  return path.join(config.artifactsDir, taskId, `${stage}.session.jsonl`);
}

/** Absolute path to a PR session's session file. */
export function prSessionPath(prSessionId: string): string {
  return path.join(config.prSessionsDir, `${prSessionId}.jsonl`);
}

/** Ensure the session file's parent directory exists. Call before spawning pi. */
export async function ensureSessionDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

// --- Read ---

/**
 * Read and parse every line of a session file. Returns `[]` if the file is
 * missing. Malformed lines are skipped with a warning. Unknown session
 * versions fail loudly: if pi ships v4, we'd rather crash than silently
 * render garbage.
 */
export async function readSessionFile(filePath: string): Promise<FileEntry[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const entries = parseLines(content);
  assertSupportedVersion(entries, filePath);
  return entries;
}

/**
 * Throws if the header's `version` is newer than `CURRENT_SESSION_VERSION`.
 * Missing `version` (very old files) and older versions are accepted; pi
 * auto-migrates them on load so their in-memory shape matches v3.
 */
function assertSupportedVersion(entries: FileEntry[], filePath: string): void {
  const header = entries.find((e) => e.type === "session") as
    | { version?: number }
    | undefined;
  const version = header?.version;
  if (version !== undefined && version > CURRENT_SESSION_VERSION) {
    throw new Error(
      `Unsupported pi session version ${version} in ${filePath}; update src/shared/session.ts to match.`,
    );
  }
}

// --- Tail ---

export type OnEntry = (entry: FileEntry) => void;

/**
 * Watch `filePath` and invoke `onEntry` for every line, including ones
 * already on disk at start. Returns a disposer that stops watching.
 *
 * Pi only creates the file after the first assistant message, so this
 * polls every 500ms until the file appears and attaches an `fs.watch` on
 * top of the poll for low-latency updates once it exists.
 */
export function watchSessionFile(filePath: string, onEntry: OnEntry): () => void {
  let offset = 0;
  let partial = "";
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pumping = false;

  async function pump(): Promise<void> {
    if (disposed || pumping) return;
    pumping = true;
    try {
      const handle = await open(filePath, "r").catch(() => null);
      if (!handle) return;
      try {
        const { size } = await handle.stat();
        if (size < offset) {
          // File was truncated or replaced; restart from the beginning.
          offset = 0;
          partial = "";
        }
        if (size === offset) return;
        const length = size - offset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        offset = size;
        const text = partial + buf.toString("utf-8");
        const lines = text.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const entry = parseLine(line);
          if (entry) onEntry(entry);
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      log.warn(`Pump failed for ${filePath}: ${String(err)}`);
    } finally {
      pumping = false;
    }
  }

  function attachWatcher(): void {
    if (watcher || disposed) return;
    try {
      watcher = watch(filePath, () => { void pump(); });
      watcher.on("error", () => { watcher?.close(); watcher = null; });
    } catch {
      // File not created yet; the poll loop will retry.
    }
  }

  async function tick(): Promise<void> {
    if (disposed) return;
    if (!watcher) {
      const exists = await stat(filePath).then(() => true).catch(() => false);
      if (exists) attachWatcher();
    }
    await pump();
    if (!disposed) pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  void tick();

  return () => {
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    watcher?.close();
    watcher = null;
  };
}

// --- Pure parsers ---

function parseLines(content: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

function parseLine(line: string): FileEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as FileEntry;
  } catch {
    log.warn(`Skipping malformed session line: ${trimmed.slice(0, 80)}...`);
    return null;
  }
}
