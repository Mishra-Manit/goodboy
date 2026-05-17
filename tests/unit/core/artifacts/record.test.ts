import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const upsertTaskArtifact = vi.fn(async (data) => ({ id: "artifact-1", ...data }));

vi.mock("@src/db/repository", () => ({ upsertTaskArtifact }));

const { recordTaskArtifact } = await import("@src/core/artifacts/record");

describe("recordTaskArtifact", () => {
  it("records declared text artifacts and materializes local files", async () => {
    const artifactsDir = await tempDir();
    const result = await recordTaskArtifact({
      taskId: "00000000-0000-0000-0000-000000000001",
      taskKind: "coding_task",
      stage: "planner",
      taskStageId: "stage-1",
      producerSessionId: null,
      artifactsDir,
      filePath: "plan.md",
      contentText: "ship it",
    });

    expect(result.filePath).toBe("plan.md");
    await expect(readFile(path.join(artifactsDir, "plan.md"), "utf8")).resolves.toBe("ship it");
    expect(upsertTaskArtifact).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "plan.md",
      contentText: "ship it",
    }));
  });

  it("rejects undeclared file paths", async () => {
    await expect(recordTaskArtifact({
      taskId: "00000000-0000-0000-0000-000000000001",
      taskKind: "coding_task",
      stage: "planner",
      taskStageId: "stage-1",
      producerSessionId: null,
      artifactsDir: await tempDir(),
      filePath: "scratch.md",
      contentText: "nope",
    })).rejects.toThrow("not a declared DB-backed artifact");
  });
});

async function tempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `goodboy-artifacts-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
