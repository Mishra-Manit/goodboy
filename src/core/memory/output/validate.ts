/**
 * Post-run validators for memory agent output. Each runs inside the stage's
 * `postValidate` hook and enforces a contract unique to its run kind:
 *
 *   cold: a valid .zones.json sidecar exists, at least one memory file is
 *         present per zone (and in _root), and the worktree is untouched.
 *   warm: .state.json + zone structure are byte-identical to what we handed
 *         the agent, file contract holds, and the worktree is untouched.
 *
 * Kept separate from the pipeline so the checks are readable on their own
 * and can be exercised without spawning pi.
 */

import {
  ROOT_MEMORY_FILES, ZONE_MEMORY_FILES, memoryDir, assertMemoryWorktreeClean,
  stateFileHash, listZoneDirs,
  type Zone,
} from "../index.js";
import { validateFileOutput } from "../../../shared/agent-output/validation.js";
import { memoryOutputs } from "../../../pipelines/memory/output-contracts.js";

// --- Public API ---

export type ColdValidation =
  | { valid: true; zones: readonly Zone[] }
  | { valid: false; reason: string };

export type WarmValidation =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Cold run validator. Returns the parsed zones sidecar on success so the
 * caller can write .state.json without re-reading it from disk.
 */
export async function validateColdOutput(repo: string): Promise<ColdValidation> {
  const zonesResult = await validateFileOutput(memoryOutputs.zones.resolve(memoryDir(repo), undefined));
  if (!zonesResult.valid) return { valid: false, reason: zonesResult.reason };
  if (!zonesResult.data) return { valid: false, reason: ".zones.json parsed without data" };

  const zones = zonesResult.data.zones;
  const names = new Set<string>();
  for (const zone of zones) {
    if (names.has(zone.name)) return { valid: false, reason: `duplicate zone name "${zone.name}"` };
    names.add(zone.name);
  }

  const fileCheck = await validateMemoryFiles(repo, zones);
  if (!fileCheck.valid) return fileCheck;

  const clean = await assertMemoryWorktreeClean(repo);
  if (!clean.clean) {
    return { valid: false, reason: `memory worktree dirty after cold: ${clean.dirty.slice(0, 5).join(", ")}` };
  }

  return { valid: true, zones };
}

/**
 * Warm run validator. Rejects any illegal structural change
 * (touched .state.json, added zone dir, missing file, dirty worktree).
 */
export async function validateWarmOutput(
  repo: string,
  expectedZones: readonly Zone[],
  stateHashBefore: string | null,
  zoneDirsBefore: readonly string[],
): Promise<WarmValidation> {
  const stateHashAfter = await stateFileHash(repo);
  if (stateHashBefore !== stateHashAfter) {
    return { valid: false, reason: "warm illegally modified .state.json" };
  }

  const zoneDirsAfter = await listZoneDirs(repo);
  const added = zoneDirsAfter.filter((d) => !zoneDirsBefore.includes(d));
  if (added.length > 0) {
    return { valid: false, reason: `warm created unauthorized zones: ${added.join(", ")}` };
  }

  const fileCheck = await validateMemoryFiles(repo, expectedZones);
  if (!fileCheck.valid) return fileCheck;

  const clean = await assertMemoryWorktreeClean(repo);
  if (!clean.clean) {
    return { valid: false, reason: `memory worktree dirty after warm: ${clean.dirty.slice(0, 5).join(", ")}` };
  }

  return { valid: true };
}

async function validateMemoryFiles(repo: string, zones: readonly Zone[]): Promise<WarmValidation> {
  const rootDir = memoryDir(repo);
  for (const file of ROOT_MEMORY_FILES) {
    const result = await validateFileOutput(memoryOutputs.rootFile.resolve(rootDir, { file }));
    if (!result.valid) return { valid: false, reason: result.reason };
  }
  for (const zone of zones) {
    for (const file of ZONE_MEMORY_FILES) {
      const result = await validateFileOutput(memoryOutputs.zoneFile.resolve(rootDir, { zone: zone.name, file }));
      if (!result.valid) return { valid: false, reason: result.reason };
    }
  }
  return { valid: true };
}
