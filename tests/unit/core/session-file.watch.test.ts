import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchSessionFile } from "@src/core/pi/session-file.js";

function entryLine(id: string): string {
  return (
    JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: [], timestamp: 0 },
    }) + "\n"
  );
}

// The watcher polls every 500ms. Real timers + a small real delay keep the
// test simple; fake timers interact poorly with `fs.watch` + file IO here.
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("watchSessionFile", { timeout: 10_000 }, () => {
  let dir: string;
  let file: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "watch-"));
    file = path.join(dir, "s.jsonl");
    stop = null;
  });

  afterEach(() => {
    stop?.();
  });

  it("waits for the file to appear, then emits every appended line", async () => {
    const seen: Array<{ id?: string }> = [];
    stop = watchSessionFile(file, (e) => seen.push(e as { id?: string }));

    // File doesn't exist yet; nothing should be emitted.
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(0);

    await writeFile(file, entryLine("m1"));
    await waitFor(() => seen.length === 1);
    expect(seen[0].id).toBe("m1");

    await appendFile(file, entryLine("m2"));
    await waitFor(() => seen.length === 2);
    expect(seen[1].id).toBe("m2");
  });

  it("buffers partial lines until a newline arrives", async () => {
    const seen: Array<{ id?: string }> = [];
    stop = watchSessionFile(file, (e) => seen.push(e as { id?: string }));

    // Write an entry without its trailing newline.
    const partial = JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: [], timestamp: 0 },
    });
    await writeFile(file, partial);
    await new Promise((r) => setTimeout(r, 1000));
    expect(seen).toHaveLength(0);

    await appendFile(file, "\n");
    await waitFor(() => seen.length === 1);
    expect(seen[0].id).toBe("m1");
  });

  it("restarts from offset 0 when the file is truncated", async () => {
    await writeFile(file, entryLine("m1") + entryLine("m2"));
    const seen: Array<{ id?: string }> = [];
    stop = watchSessionFile(file, (e) => seen.push(e as { id?: string }));

    await waitFor(() => seen.length === 2);

    // Truncate + replace -- simulates pi rewriting the file from scratch.
    await writeFile(file, entryLine("fresh"));
    await waitFor(() => seen.length === 3);
    expect(seen[2].id).toBe("fresh");
  });

  it("stops emitting after the disposer is called", async () => {
    await writeFile(file, entryLine("m1"));
    const seen: Array<{ id?: string }> = [];
    const dispose = watchSessionFile(file, (e) => seen.push(e as { id?: string }));
    stop = dispose;

    await waitFor(() => seen.length === 1);
    dispose();
    stop = null;

    await appendFile(file, entryLine("after-stop"));
    await new Promise((r) => setTimeout(r, 800));
    expect(seen).toHaveLength(1);
  });

  it("skips malformed JSON lines without breaking the stream", async () => {
    const seen: Array<{ id?: string }> = [];
    stop = watchSessionFile(file, (e) => seen.push(e as { id?: string }));

    await writeFile(file, "{ not json\n" + entryLine("m1"));
    await waitFor(() => seen.length === 1);
    expect(seen[0].id).toBe("m1");
  });
});
