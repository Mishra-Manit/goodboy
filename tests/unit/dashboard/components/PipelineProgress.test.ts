import { describe, expect, it } from "vitest";
import { rollupStages } from "@dashboard/lib/pipeline-progress.js";
import type { TaskStage } from "@dashboard/lib/api";

function stage(variant: number | null, status: TaskStage["status"], times?: Partial<TaskStage>): TaskStage {
  return {
    id: `stage-${variant ?? "main"}`,
    taskId: "task-1",
    stage: "pr_impact",
    variant,
    status,
    startedAt: times?.startedAt ?? "2026-04-29T00:00:00.000Z",
    completedAt: times?.completedAt ?? null,
    piSessionId: null,
    error: null,
  };
}

describe("rollupStages", () => {
  it("marks all complete variants complete", () => {
    const rollup = rollupStages([
      stage(1, "complete", { completedAt: "2026-04-29T00:00:03.000Z" }),
      stage(2, "complete", { completedAt: "2026-04-29T00:00:02.000Z" }),
    ]).get("pr_impact");

    expect(rollup?.status).toBe("complete");
  });

  it("marks partial success as mixed rather than failed or complete", () => {
    const rollup = rollupStages([
      stage(1, "complete", { completedAt: "2026-04-29T00:00:03.000Z" }),
      stage(2, "failed", { completedAt: "2026-04-29T00:00:02.000Z" }),
    ]).get("pr_impact");

    expect(rollup?.status).toBe("mixed");
  });

  it("marks all failed variants failed", () => {
    const rollup = rollupStages([
      stage(1, "failed", { completedAt: "2026-04-29T00:00:03.000Z" }),
      stage(2, "failed", { completedAt: "2026-04-29T00:00:02.000Z" }),
    ]).get("pr_impact");

    expect(rollup?.status).toBe("failed");
  });

  it("uses earliest start and latest completion across variants", () => {
    const rollup = rollupStages([
      stage(1, "complete", {
        startedAt: "2026-04-29T00:00:02.000Z",
        completedAt: "2026-04-29T00:00:10.000Z",
      }),
      stage(2, "complete", {
        startedAt: "2026-04-29T00:00:01.000Z",
        completedAt: "2026-04-29T00:00:08.000Z",
      }),
    ]).get("pr_impact");

    expect(rollup?.startedAt).toBe("2026-04-29T00:00:01.000Z");
    expect(rollup?.completedAt).toBe("2026-04-29T00:00:10.000Z");
  });
});
