/**
 * Filesystem helpers for task artifact directories under `artifacts/<taskId>/`.
 * Centralizes path building plus the reset-and-recreate flow used by pipelines.
 */

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { config } from "../runtime/config.js";

// --- Paths ---

/** Absolute artifacts directory for one task. */
export function taskArtifactsDir(taskId: string): string {
  return path.join(config.artifactsDir, taskId);
}

/** Absolute path to one artifact file inside a task's artifacts directory. */
export function artifactPath(artifactsDir: string, filename: string): string {
  return path.join(artifactsDir, filename);
}

// --- Public API ---

/** Reset a task's artifacts directory and create any requested subdirectories. */
export async function prepareArtifactsDir(taskId: string, subdirs: readonly string[] = []): Promise<string> {
  const dir = taskArtifactsDir(taskId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  await Promise.all(subdirs.map((subdir) => mkdir(path.join(dir, subdir), { recursive: true })));
  return dir;
}

