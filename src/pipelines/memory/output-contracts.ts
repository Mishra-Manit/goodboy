/** Output contracts for cold and warm memory maintenance runs. */

import { defineJsonOutput, defineTextOutput } from "../../shared/agent-output/contracts.js";
import {
  ROOT_DIR,
  ROOT_MEMORY_FILES,
  ZONE_MEMORY_FILES,
  zonesSidecarSchema,
  type RootMemoryFile,
  type ZoneMemoryFile,
} from "../../core/memory/index.js";

export const memoryOutputs = {
  zones: defineJsonOutput({
    id: "memory.zones",
    path: () => ".zones.json",
    schema: zonesSidecarSchema.strict(),
    prompt: {
      name: "memory zones sidecar",
      instructions: "Cold runs write the discovered zone list here before memory files.",
      skeleton: `{"zones":[]}`,
    },
  }),
  rootFile: defineTextOutput({
    id: "memory.rootFile",
    path: ({ file }: { file: RootMemoryFile }) => `${ROOT_DIR}/${file}`,
    prompt: { name: "root memory file", instructions: "Write a non-empty cited markdown memory file." },
  }),
  zoneFile: defineTextOutput({
    id: "memory.zoneFile",
    path: ({ zone, file }: { zone: string; file: ZoneMemoryFile }) => `${zone}/${file}`,
    prompt: { name: "zone memory file", instructions: "Write a non-empty cited markdown memory file." },
  }),
};

export function rootMemoryContracts(memoryDir: string) {
  return ROOT_MEMORY_FILES.map((file) => memoryOutputs.rootFile.resolve(memoryDir, { file }));
}

export function zoneMemoryContracts(memoryDir: string, zone: string) {
  return ZONE_MEMORY_FILES.map((file) => memoryOutputs.zoneFile.resolve(memoryDir, { zone, file }));
}
