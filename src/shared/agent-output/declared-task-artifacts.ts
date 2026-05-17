/**
 * Registry of canonical task artifacts that must be persisted to Postgres.
 * PR review, memory, raw JSONL, diffs, and binary assets intentionally stay out.
 */

import path from "node:path";
import type { ResolvedFileOutputContract } from "./contracts.js";
import type { StageName, TaskKind } from "../domain/types.js";

export interface DeclaredArtifactMatch {
  filePath: string;
  contract: ResolvedFileOutputContract;
}

interface DeclaredArtifactSpec {
  kind: TaskKind;
  stage: StageName;
  filePath: string;
  contract: Omit<ResolvedFileOutputContract, "path">;
}

const DECLARED_DB_ARTIFACTS: readonly DeclaredArtifactSpec[] = [
  textArtifact("coding_task", "planner", "plan.md", "coding.plan", "implementation plan", "Write the complete implementation plan here."),
  textArtifact(
    "coding_task",
    "implementer",
    "implementation-summary.md",
    "coding.implementationSummary",
    "implementation summary",
    "Write the final implementation summary here.",
  ),
  textArtifact("coding_task", "reviewer", "review.md", "coding.review", "implementation review", "Write the final self-review here."),
  textArtifact("codebase_question", "answering", "answer.md", "question.answer", "codebase answer", "Write the user-facing answer here as plain text."),
];

/** Declared DB-backed artifacts for one task stage. */
export function declaredArtifactsForStage(options: {
  kind: TaskKind;
  stage: StageName;
  artifactsDir: string;
}): DeclaredArtifactMatch[] {
  return DECLARED_DB_ARTIFACTS
    .filter((artifact) => artifact.kind === options.kind && artifact.stage === options.stage)
    .map((artifact) => ({
      filePath: artifact.filePath,
      contract: { ...artifact.contract, path: path.join(options.artifactsDir, artifact.filePath) },
    }));
}

/** Resolve an absolute artifact path into its artifacts-dir-relative path. */
export function relativeToArtifacts(artifactsDir: string, absolutePath: string): string {
  return path.relative(artifactsDir, absolutePath).replace(/\\/g, "/");
}

/** Find a declared DB-backed artifact contract by file path. */
export function resolveDeclaredArtifactByFilePath(options: {
  kind: TaskKind;
  stage: StageName;
  artifactsDir: string;
  filePath: string;
}): ResolvedFileOutputContract | null {
  const normalized = options.filePath.replace(/\\/g, "/");
  const artifact = DECLARED_DB_ARTIFACTS.find((candidate) => (
    candidate.kind === options.kind
    && candidate.stage === options.stage
    && candidate.filePath === normalized
  ));
  if (!artifact) return null;
  return { ...artifact.contract, path: path.join(options.artifactsDir, artifact.filePath) };
}

function textArtifact(
  kind: TaskKind,
  stage: StageName,
  filePath: string,
  id: string,
  name: string,
  instructions: string,
): DeclaredArtifactSpec {
  return {
    kind,
    stage,
    filePath,
    contract: {
      id,
      kind: "text",
      policy: "required",
      dashboard: { key: filePath, label: name.replace(/^implementation /, "") },
      prompt: { name, instructions },
    },
  };
}
