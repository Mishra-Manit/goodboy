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
  readZonesSidecar, memoryFilesValid, assertMemoryWorktreeClean,
  stateFileHash, listZoneDirs,
  type Zone,
} from "./index.js";

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
  const zones = await readZonesSidecar(repo);
  if (zones === null) return { valid: false, reason: ".zones.json missing or invalid" };

  const fileCheck = memoryFilesValid(repo, zones);
  if (!fileCheck.valid) return { valid: false, reason: fileCheck.reason ?? "memory files invalid" };

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

  const fileCheck = memoryFilesValid(repo, expectedZones);
  if (!fileCheck.valid) return { valid: false, reason: fileCheck.reason ?? "memory files invalid" };

  const clean = await assertMemoryWorktreeClean(repo);
  if (!clean.clean) {
    return { valid: false, reason: `memory worktree dirty after warm: ${clean.dirty.slice(0, 5).join(", ")}` };
  }

  return { valid: true };
}
