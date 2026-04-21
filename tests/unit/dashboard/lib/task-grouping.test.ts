import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { groupByDate } from "@dashboard/lib/task-grouping.js";
import type { Task } from "@dashboard/lib/api";

function mkTask(id: string, createdAt: string): Task {
  return { id, createdAt } as unknown as Task;
}

describe("groupByDate", () => {
  beforeEach(() => {
    // Anchor "now" to noon UTC so day boundaries are deterministic.
    vi.useFakeTimers().setSystemTime(new Date("2026-04-21T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("buckets into today / yesterday / this week / older, in that order", () => {
    const tasks: Task[] = [
      mkTask("older",     "2026-03-01T00:00:00Z"),
      mkTask("today",     "2026-04-21T09:00:00Z"),
      mkTask("yesterday", "2026-04-20T09:00:00Z"),
      mkTask("thisweek",  "2026-04-17T09:00:00Z"),
    ];
    const grouped = groupByDate(tasks);
    expect(grouped.map((g) => g.label)).toEqual([
      "today",
      "yesterday",
      "this week",
      "older",
    ]);
    expect(grouped[0].tasks.map((t) => t.id)).toEqual(["today"]);
    expect(grouped[3].tasks.map((t) => t.id)).toEqual(["older"]);
  });

  it("drops buckets with no tasks", () => {
    const tasks: Task[] = [mkTask("t", "2026-04-21T10:00:00Z")];
    const grouped = groupByDate(tasks);
    expect(grouped.map((g) => g.label)).toEqual(["today"]);
  });

  it("handles empty input", () => {
    expect(groupByDate([])).toEqual([]);
  });

});
