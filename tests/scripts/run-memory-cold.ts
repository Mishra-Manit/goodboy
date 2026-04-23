/**
 * Manual cold-start test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-cold.ts <test-label> <repo-name>
 *
 * Generates a TEST-prefixed instance ID so artifacts are clearly isolated
 * from production memory. Prints the instance ID at the end for use with
 * run-memory-warm.ts.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const [, , testLabel, repoName] = process.argv;
if (!testLabel || !repoName) {
  console.error("Usage: npx tsx tests/scripts/run-memory-cold.ts <test-label> <repo-name>");
  process.exit(1);
}

// Set BEFORE any loadEnv() call so the generated ID is picked up everywhere.
const instanceId = `TEST-${randomBytes(4).toString("hex")}`;
process.env["INSTANCE_ID"] = instanceId;

// Dynamic imports so the env override lands first.
const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath } = await import("../../src/core/memory/index.js");

const repo = getRepo(repoName);
if (!repo) {
  console.error(`Unknown repo: ${repoName}. Check REGISTERED_REPOS.`);
  process.exit(1);
}

const noopTelegram = async () => {};

console.log(`\n=== MEMORY COLD-START TEST ===`);
console.log(`label      : ${testLabel}`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`\nRunning cold memory stage...\n`);

await runMemory({
  taskId: `${testLabel}-cold`,
  repo: repoName,
  repoPath: repo.localPath,
  source: "manual_test",
  sendTelegram: noopTelegram,
  chatId: null,
});

try {
  const state = JSON.parse(await readFile(memoryStatePath(repoName), "utf8"));
  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${state.zones?.length ?? 0}`);
  console.log(`sha        : ${state.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${state.lastIndexedAt}`);
} catch {
  console.error(`No .state.json found -- cold run may have failed.`);
}

console.log(`\nTo test warm, run:`);
console.log(`  npm run test:memory:warm -- ${testLabel} ${repoName} ${instanceId}\n`);
