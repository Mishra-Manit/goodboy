/**
 * Cleans up manual TEST memory runs from both the database and local artifacts.
 * Shared by the API and CLI so both paths behave the same way.
 */

import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import * as queries from "../../db/repository.js";

const log = createLogger("memory-cleanup");

const TEST_MEMORY_DIR_PREFIX = "memory-TEST-";

// --- Public API ---

export interface MemoryTestCleanupResult {
  deletedRows: number;
  deletedTranscriptDirs: number;
  deletedMemoryDirs: number;
}

/** Delete TEST memory runs plus any local transcript and memory directories they reference. */
export async function cleanupTestMemoryRuns(): Promise<MemoryTestCleanupResult> {
  const deletedRows = await queries.deleteTestMemoryRuns();
  const transcriptDirs = uniqueTranscriptDirs(deletedRows.map((row) => row.sessionPath));
  const memoryDirs = await listTestMemoryDirs();

  const deletedTranscriptDirs = await deleteDirs(transcriptDirs);
  const deletedMemoryDirs = await deleteDirs(memoryDirs);

  return {
    deletedRows: deletedRows.length,
    deletedTranscriptDirs,
    deletedMemoryDirs,
  };
}

// --- Helpers ---

function uniqueTranscriptDirs(sessionPaths: Array<string | null>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];

  for (const sessionPath of sessionPaths) {
    if (!sessionPath) continue;
    const dir = transcriptDirForSession(sessionPath);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }

  return dirs;
}

function transcriptDirForSession(sessionPath: string): string | null {
  const artifactsBase = path.resolve(config.artifactsDir);
  const dir = path.resolve(path.dirname(sessionPath));
  if (dir === artifactsBase) return null;
  if (!dir.startsWith(`${artifactsBase}${path.sep}`)) return null;
  return dir;
}

async function listTestMemoryDirs(): Promise<string[]> {
  try {
    const entries = await readdir(config.artifactsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_MEMORY_DIR_PREFIX))
      .map((entry) => path.join(config.artifactsDir, entry.name));
  } catch (err) {
    log.warn(`Failed to list TEST memory dirs under ${config.artifactsDir}`, err);
    return [];
  }
}

async function deleteDirs(dirs: string[]): Promise<number> {
  let deleted = 0;

  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
      deleted += 1;
    } catch (err) {
      log.warn(`Failed to remove directory ${dir}`, err);
    }
  }

  return deleted;
}
