/**
 * Filesystem helpers for task artifact directories under `artifacts/<taskId>/`.
 * Centralizes path building plus the reset-and-recreate flow used by pipelines.
 */

import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { config } from "./config.js";

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

/** True when an artifact exists and is non-empty. */
export async function hasNonEmptyArtifact(artifactsDir: string, filename: string): Promise<boolean> {
  try {
    const info = await stat(artifactPath(artifactsDir, filename));
    return info.size > 0;
  } catch {
    return false;
  }
}

/** Assert that an artifact exists and is non-empty; throws with `errorMsg` otherwise. */
export async function requireNonEmptyArtifact(
  artifactsDir: string,
  filename: string,
  errorMsg: string,
): Promise<string> {
  const filePath = artifactPath(artifactsDir, filename);
  try {
    const info = await stat(filePath);
    if (info.size === 0) throw new Error(`${errorMsg} (file is empty: ${filePath})`);
    return filePath;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(errorMsg)) throw err;
    throw new Error(`${errorMsg} (expected at ${filePath})`);
  }
}
