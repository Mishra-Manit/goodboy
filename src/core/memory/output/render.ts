/** Render memory files into prompt context blocks for pipeline stages. */

import {
  readState,
  readAllMemory,
  ROOT_MEMORY_FILES,
  ZONE_MEMORY_FILES,
  ROOT_DIR,
} from "../index.js";

/** Render every memory file for downstream stages, or an empty string when none exists. */
export async function memoryBlock(repo: string): Promise<string> {
  const state = await readState(repo);
  if (!state) return "";

  const { root, zones } = await readAllMemory(repo, state.zones);
  const rootBody = ROOT_MEMORY_FILES
    .filter((n) => root[n])
    .map((n) => `=== MEMORY ${ROOT_DIR}/${n} ===\n${root[n]!.trim()}\n=== END ${ROOT_DIR}/${n} ===`)
    .join("\n\n");

  const zoneBody = zones.map(({ zone, files }) => {
    const header = `--- ZONE: ${zone.name} (${zone.path}) — ${zone.summary} ---`;
    const body = ZONE_MEMORY_FILES
      .filter((n) => files[n])
      .map((n) => `=== MEMORY ${zone.name}/${n} ===\n${files[n]!.trim()}\n=== END ${zone.name}/${n} ===`)
      .join("\n\n");
    return `${header}\n${body}`;
  }).join("\n\n");

  if (!rootBody && !zoneBody) return "";

  return `
CODEBASE MEMORY:
Agent-maintained knowledge base for this repo. Every factual claim cites the
source file it was drawn from. Trust this as context, but prefer a direct
file read if a claim contradicts what you see in code.

${rootBody}

${zoneBody}
`;
}
