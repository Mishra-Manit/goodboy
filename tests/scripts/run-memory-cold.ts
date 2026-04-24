/**
 * Manual cold-start test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-cold.ts <repo-name>
 *
 * Generates a TEST-prefixed instance ID so artifacts are clearly isolated
 * from production memory. The task ID derives from the instance ID, so
 * every invocation gets a fresh session path (no pi session resume across
 * runs). Prints the instance ID at the end for use with run-memory-warm.ts.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TEST_INSTANCE_PREFIX } from "../../src/shared/test-instance.js";

const [, , repoName] = process.argv;
if (!repoName) {
  console.error("Usage: npx tsx tests/scripts/run-memory-cold.ts <repo-name>");
  process.exit(1);
}

// Set BEFORE any loadEnv() call so the generated ID is picked up everywhere.
const instanceId = `${TEST_INSTANCE_PREFIX}${randomBytes(4).toString("hex")}`;
const taskId = `${instanceId}-cold`;
process.env["INSTANCE_ID"] = instanceId;

// Dynamic imports so the env override lands first.
const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath } = await import("../../src/core/memory/index.js");
const { initObservability, shutdownObservability } = await import(
  "../../src/observability/index.js"
);

initObservability();

const repo = getRepo(repoName);
if (!repo) {
  console.error(`Unknown repo: ${repoName}. Check REGISTERED_REPOS.`);
  process.exit(1);
}

const noopTelegram = async () => {};

console.log(`\n=== MEMORY COLD-START TEST ===`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`taskId     : ${taskId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`\nRunning cold memory stage...\n`);

try {
  await runMemory({
    taskId,
    repo: repoName,
    repoPath: repo.localPath,
    source: "manual_test",
    sendTelegram: noopTelegram,
    chatId: null,
  });
} finally {
  await shutdownObservability();
}

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
console.log(`  npm run test:memory:warm -- ${repoName} ${instanceId}\n`);
