import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runImpactAnalyzers } from "@src/pipelines/pr-review/impact-analyzer.js";

const mocks = vi.hoisted(() => ({
  runStage: vi.fn(),
  isTaskCancelled: vi.fn(() => false),
}));

vi.mock("@src/core/stage.js", () => ({
  TaskCancelledError: class TaskCancelledError extends Error {},
  isTaskCancelled: () => mocks.isTaskCancelled(),
  runStage: (...args: unknown[]) => mocks.runStage(...args),
}));

const noopSend = async () => {};

async function artifactsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "impact-fanout-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

function options(dir: string) {
  return {
    taskId: "task-1",
    repo: "goodboy",
    artifactsDir: dir,
    worktreePath: dir,
    sendTelegram: noopSend,
    memoryBody: "memory",
  };
}

describe("runImpactAnalyzers", () => {
  beforeEach(() => {
    mocks.runStage.mockReset();
    mocks.isTaskCancelled.mockReset();
    mocks.isTaskCancelled.mockReturnValue(false);
  });

  it("returns all available variants when all stages succeed", async () => {
    const dir = await artifactsDir();
    mocks.runStage.mockImplementation(async (opts: { variant: number }) => {
      await writeFile(join(dir, `pr-impact.v${opts.variant}.md`), "impact\nIMPACT_ANALYSIS_DONE");
      return { ok: true };
    });

    await expect(runImpactAnalyzers(options(dir))).resolves.toEqual({ available: [1, 2, 3], ok: true });
  });

  it("keeps successful variants when one stage fails", async () => {
    const dir = await artifactsDir();
    mocks.runStage.mockImplementation(async (opts: { variant: number }) => {
      if (opts.variant === 2) throw new Error("boom");
      await writeFile(join(dir, `pr-impact.v${opts.variant}.md`), "impact\nIMPACT_ANALYSIS_DONE");
      return { ok: true };
    });

    await expect(runImpactAnalyzers(options(dir))).resolves.toEqual({ available: [1, 3], ok: true });
  });

  it("returns ok false when every variant fails", async () => {
    const dir = await artifactsDir();
    mocks.runStage.mockRejectedValue(new Error("boom"));

    await expect(runImpactAnalyzers(options(dir))).resolves.toEqual({ available: [], ok: false });
  });

  it("propagates task cancellation after variant fanout settles", async () => {
    const dir = await artifactsDir();
    mocks.runStage.mockRejectedValue(new Error("cancelled"));
    mocks.isTaskCancelled.mockReturnValue(true);

    await expect(runImpactAnalyzers(options(dir))).rejects.toThrow("task-1");
  });

  it("rejects variants whose impact files lack the sentinel", async () => {
    const dir = await artifactsDir();
    mocks.runStage.mockImplementation(async (opts: {
      variant: number;
      postValidate?: () => Promise<{ valid: boolean; reason?: string }>;
    }) => {
      await writeFile(join(dir, `pr-impact.v${opts.variant}.md`), "partial impact");
      const result = await opts.postValidate?.();
      return result?.valid ? { ok: true } : { ok: false, reason: result?.reason ?? "invalid" };
    });

    await expect(runImpactAnalyzers(options(dir))).resolves.toEqual({ available: [], ok: false });
  });
});
