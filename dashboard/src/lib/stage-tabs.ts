/** Pure helpers for task transcript tab identity and ordering. */

import type { FileEntry, StageName, TaskStage } from "./api";

export interface StageTab {
  key: string;
  label: string;
  stage: TaskStage | null;
}

export interface StageSessionLike {
  stage: StageName;
  variant: number | null;
  entries: FileEntry[];
}

export function buildStageTabs(
  stages: readonly TaskStage[],
  diskEntries: readonly StageSessionLike[],
  liveEntries: Map<string, FileEntry[]>,
  stageOrder: readonly StageName[],
): StageTab[] {
  const latestStageRows = new Map<string, TaskStage>();
  for (const stage of stages) {
    latestStageRows.set(stageSessionKey(stage.stage, stage.variant), stage);
  }

  const orderedRows = stageOrder.flatMap((stageName) => (
    [...latestStageRows.values()]
      .filter((stage) => stage.stage === stageName)
      .sort((a, b) => (a.variant ?? 0) - (b.variant ?? 0))
      .map(stageTabFromRow)
  ));
  const knownKeys = new Set(orderedRows.map((row) => row.key));
  const extraRows = [...latestStageRows.values()]
    .filter((stage) => !knownKeys.has(stageSessionKey(stage.stage, stage.variant)))
    .map(stageTabFromRow);
  const withStageKeys = new Set([...knownKeys, ...extraRows.map((row) => row.key)]);
  const diskRows = diskEntries
    .map((entry) => ({
      key: stageSessionKey(entry.stage, entry.variant),
      label: stageLabel(entry.stage, entry.variant),
      stage: null,
    }))
    .filter((entry) => !withStageKeys.has(entry.key));
  const withDiskKeys = new Set([...withStageKeys, ...diskRows.map((row) => row.key)]);
  const liveRows = [...liveEntries.keys()]
    .filter((key) => !withDiskKeys.has(key))
    .map((key) => ({ key, label: labelFromSessionKey(key), stage: null }));
  return [...orderedRows, ...extraRows, ...diskRows, ...liveRows];
}

export function stageSessionKey(stage: StageName, variant: number | null | undefined): string {
  return variant === null || variant === undefined ? stage : `${stage}#${variant}`;
}

function stageTabFromRow(stage: TaskStage): StageTab {
  return {
    key: stageSessionKey(stage.stage, stage.variant),
    label: stageLabel(stage.stage, stage.variant),
    stage,
  };
}

function stageLabel(stage: StageName, variant: number | null | undefined): string {
  const base = stage.replace(/_/g, " ");
  return variant === null || variant === undefined ? base : `${base} v${variant}`;
}

function labelFromSessionKey(key: string): string {
  const [rawStage, variant] = key.split("#");
  const stage = rawStage ?? key;
  return variant ? `${stage.replace(/_/g, " ")} v${variant}` : stage.replace(/_/g, " ");
}
