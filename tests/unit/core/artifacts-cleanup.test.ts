import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, utimes, rm, readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectExpiredTaskArtifacts,
  sweepExpiredTaskArtifacts,
  type ArtifactDirEntry,
} from "@src/core/artifacts-cleanup.js";

const DAY = 24 * 60 * 60 * 1000;
const TTL = 14 * DAY;
const NOW = 1_700_000_000_000;
const FRESH_UUID = "11111111-1111-1111-1111-111111111111";
const STALE_UUID = "22222222-2222-2222-2222-222222222222";

describe("selectExpiredTaskArtifacts", () => {
  it("returns UUID-named dirs older than the TTL", () => {
    const entries: ArtifactDirEntry[] = [
      { name: STALE_UUID, mtimeMs: NOW - TTL - 1 },
      { name: FRESH_UUID, mtimeMs: NOW - TTL + 1 },
    ];
    expect(selectExpiredTaskArtifacts(entries, NOW, TTL)).toEqual([STALE_UUID]);
  });

  it("ignores non-UUID entries even when stale", () => {
    const entries: ArtifactDirEntry[] = [
      { name: "memory-dev-coliseum", mtimeMs: NOW - 99 * DAY },
      { name: "TEST-abcdef-cold", mtimeMs: NOW - 99 * DAY },
      { name: "scratch.txt", mtimeMs: NOW - 99 * DAY },
    ];
    expect(selectExpiredTaskArtifacts(entries, NOW, TTL)).toEqual([]);
  });

  it("treats mtime exactly at the cutoff as not expired", () => {
    const entries: ArtifactDirEntry[] = [
      { name: STALE_UUID, mtimeMs: NOW - TTL },
    ];
    expect(selectExpiredTaskArtifacts(entries, NOW, TTL)).toEqual([]);
  });

  it("returns an empty array when no entries match", () => {
    expect(selectExpiredTaskArtifacts([], NOW, TTL)).toEqual([]);
  });
});

describe("sweepExpiredTaskArtifacts (IO)", () => {
  let tmpRoot: string;
  let configMock: { default: { artifactsDir: string; prSessionsDir: string; piCommand: string } };

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "goodboy-sweep-"));
    configMock = {
      default: { artifactsDir: tmpRoot, prSessionsDir: "/unused", piCommand: "pi" },
    };
    vi.doMock("@src/shared/runtime/config.js", () => ({ config: configMock.default }));
  });

  afterEach(async () => {
    vi.doUnmock("@src/shared/runtime/config.js");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeDir(name: string, mtimeMs: number): Promise<void> {
    const full = path.join(tmpRoot, name);
    await mkdir(full, { recursive: true });
    await writeFile(path.join(full, "marker"), "x");
    const t = new Date(mtimeMs);
    await utimes(full, t, t);
  }

  it("removes only stale UUID-named dirs and leaves everything else", async () => {
    await makeDir(STALE_UUID, NOW - TTL - DAY);
    await makeDir(FRESH_UUID, NOW - DAY);
    await makeDir("memory-dev-coliseum", NOW - 99 * DAY);

    const { sweepExpiredTaskArtifacts: sweep } = await import("@src/core/artifacts-cleanup.js");
    const result = await sweep(NOW, TTL);

    expect(result.deleted).toEqual([STALE_UUID]);
    expect(result.failed).toEqual([]);
    expect(result.scanned).toBe(3);

    const remaining = await readdir(tmpRoot);
    expect(remaining.sort()).toEqual([FRESH_UUID, "memory-dev-coliseum"].sort());
  });

  it("returns an empty result when artifacts dir is missing", async () => {
    await rm(tmpRoot, { recursive: true, force: true });

    const { sweepExpiredTaskArtifacts: sweep } = await import("@src/core/artifacts-cleanup.js");
    const result = await sweep(NOW, TTL);

    expect(result).toEqual({ scanned: 0, deleted: [], failed: [] });
  });
});
