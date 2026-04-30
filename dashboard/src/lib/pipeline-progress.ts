/** Pure stage rollup helpers for pipeline progress rendering. */

import type { TaskStage } from "./api";

export type DisplayStatus = "pending" | "active" | "complete" | "failed" | "skipped" | "mixed";

export interface StageRollup {
  status: DisplayStatus;
  rows: TaskStage[];
  startedAt: string | null;
  completedAt: string | null;
}

export function rollupStages(stages: readonly TaskStage[]): Map<string, StageRollup> {
  const grouped = new Map<string, TaskStage[]>();
  for (const stage of stages) {
    grouped.set(stage.stage, [...(grouped.get(stage.stage) ?? []), stage]);
  }

  return new Map([...grouped.entries()].map(([stage, rows]) => [stage, rollupStageRows(rows)]));
}

function rollupStageRows(rows: TaskStage[]): StageRollup {
  const orderedRows = [...rows].sort((a, b) => (a.variant ?? 0) - (b.variant ?? 0));
  const completedRows = orderedRows.filter((row) => row.completedAt);

  return {
    status: rollupStatus(orderedRows.map(displayStatus)),
    rows: orderedRows,
    startedAt: minString(orderedRows.map((row) => row.startedAt)),
    completedAt: completedRows.length === orderedRows.length
      ? maxString(completedRows.map((row) => row.completedAt!))
      : null,
  };
}

function rollupStatus(statuses: readonly DisplayStatus[]): DisplayStatus {
  if (statuses.includes("active")) return "active";
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  if (statuses.includes("complete") && (statuses.includes("failed") || statuses.includes("skipped"))) {
    return "mixed";
  }
  return statuses[0] ?? "pending";
}

// ISO 8601 timestamps sort correctly as strings; no Date parsing needed.
function minString(values: readonly string[]): string | null {
  return values.reduce<string | null>((min, value) => (min === null || value < min ? value : min), null);
}

function maxString(values: readonly string[]): string | null {
  return values.reduce<string | null>((max, value) => (max === null || value > max ? value : max), null);
}

export function displayStatus(stage: TaskStage | undefined): DisplayStatus {
  if (!stage) return "pending";
  if (stage.status === "running") return "active";
  return stage.status;
}
