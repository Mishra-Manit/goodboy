import { describe, expect, it } from "vitest";
import { buildStageTabs } from "@dashboard/lib/stage-tabs.js";
import type { FileEntry, StageName, TaskStage } from "@dashboard/lib/api";

function stage(stageName: StageName, variant: number | null = null): TaskStage {
  return {
    id: `${stageName}-${variant ?? "main"}`,
    taskId: "task-1",
    stage: stageName,
    variant,
    status: "complete",
    startedAt: "2026-04-29T00:00:00.000Z",
    completedAt: "2026-04-29T00:00:01.000Z",
    piSessionId: null,
    error: null,
  };
}

const entry: FileEntry = {
  type: "session",
  id: "session-1",
  version: 3,
  timestamp: "2026-04-29T00:00:00.000Z",
  cwd: "/tmp",
};

describe("buildStageTabs", () => {
  it("orders tabs by canonical stage order and variant number", () => {
    const tabs = buildStageTabs(
      [stage("pr_analyst"), stage("pr_impact", 2), stage("memory"), stage("pr_impact", 1)],
      [],
      new Map(),
      ["memory", "pr_impact", "pr_analyst", "pr_display"],
    );

    expect(tabs.map((tab) => tab.key)).toEqual(["memory", "pr_impact#1", "pr_impact#2", "pr_analyst"]);
  });

  it("dedupes duplicate stage rows by session key", () => {
    const tabs = buildStageTabs(
      [stage("pr_impact", 1), { ...stage("pr_impact", 1), id: "latest" }],
      [],
      new Map(),
      ["pr_impact"],
    );

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.stage?.id).toBe("latest");
  });

  it("adds disk and live-only tabs without duplicating DB-backed keys", () => {
    const tabs = buildStageTabs(
      [stage("memory")],
      [
        { stage: "memory", variant: null, entries: [entry] },
        { stage: "pr_impact", variant: 1, entries: [entry] },
      ],
      new Map([["pr_impact#2", [entry]]]),
      ["memory", "pr_impact"],
    );

    expect(tabs.map((tab) => tab.key)).toEqual(["memory", "pr_impact#1", "pr_impact#2"]);
    expect(tabs.map((tab) => tab.label)).toEqual(["memory", "pr impact v1", "pr impact v2"]);
  });
});
