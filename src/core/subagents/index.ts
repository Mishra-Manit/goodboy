/**
 * pi-subagents integration. Owns extension resolution, per-stage capability
 * bundles, and worktree asset staging. Stages opt in via `subagentCapability()`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cp, stat } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("subagents");
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Paths ---

const ASSETS_DIR = path.resolve(__dirname, "../../../pi-assets");

function resolveExtensionPath(): string {
  try {
    return require.resolve("pi-subagents/index.ts");
  } catch (err) {
    throw new Error(
      `Failed to resolve pi-subagents. Run 'npm install'. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const EXTENSION_PATH = resolveExtensionPath();

// --- Public API ---

export interface SubagentCapability {
  extensions: string[];
  envOverrides: Record<string, string>;
}

/** Capability bundle for a stage that delegates to pi-subagents. */
export function subagentCapability(opts?: { maxDepth?: number }): SubagentCapability {
  return {
    extensions: [EXTENSION_PATH],
    envOverrides: { PI_SUBAGENT_MAX_DEPTH: String(opts?.maxDepth ?? 1) },
  };
}

/**
 * Copy agent definitions into `<worktree>/.pi/`. Destination is `.pi/` (not
 * `.pi/agent/`) because pi-subagents discovers project-scoped agents at
 * `<worktree>/.pi/agents/*.md`.
 */
export async function stageSubagentAssets(worktreePath: string): Promise<void> {
  try {
    await stat(ASSETS_DIR);
  } catch {
    log.warn(`pi-assets directory missing at ${ASSETS_DIR}; skipping`);
    return;
  }
  const dest = path.join(worktreePath, ".pi");
  await cp(ASSETS_DIR, dest, { recursive: true, force: true });
  log.info(`Staged subagent assets into ${dest}`);
}
