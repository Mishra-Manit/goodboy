/**
 * Manual warm-patch test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-warm.ts <repo-name> <TEST-instance-id>
 *
 * Reuses the memory directory created by run-memory-cold.ts. The instance ID
 * must be the TEST-prefixed value printed by the cold runner. The task ID
 * derives from the instance ID so every invocation writes to a fresh session
 * path (no pi session resume across runs).
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TEST_INSTANCE_PREFIX, isTestInstance } from "../../src/shared/test-instance.js";

const [, , repoName, instanceId] = process.argv;
if (!repoName || !instanceId) {
  console.error(
    `Usage: npx tsx tests/scripts/run-memory-warm.ts <repo-name> <${TEST_INSTANCE_PREFIX}instance-id>`,
  );
  process.exit(1);
}
if (!isTestInstance(instanceId)) {
  console.error(`instance-id must start with ${TEST_INSTANCE_PREFIX}. Got: ${instanceId}`);
  process.exit(1);
}

const taskId = `${instanceId}-warm`;
process.env["INSTANCE_ID"] = instanceId;

const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath, zonesSidecarPath } = await import("../../src/core/memory/index.js");
const { initObservability, shutdownObservability } = await import(
  "../../src/observability/index.js"
);

initObservability();

const repo = getRepo(repoName);
if (!repo) {
  console.error(`Unknown repo: ${repoName}. Check REGISTERED_REPOS.`);
  process.exit(1);
}

const statePath = memoryStatePath(repoName);
let stateBefore: string;
try {
  stateBefore = await readFile(statePath, "utf8");
} catch {
  console.error(
    `No .state.json found at ${statePath}.\nRun the cold script first:\n  npm run test:memory:cold -- ${repoName}`,
  );
  process.exit(1);
}

const zonesPath = zonesSidecarPath(repoName);
const zonesHashBefore = await readFile(zonesPath, "utf8")
  .then((c) => createHash("sha256").update(c).digest("hex"))
  .catch(() => null);

const parsedBefore = JSON.parse(stateBefore);

console.log(`\n=== MEMORY WARM-PATCH TEST ===`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`taskId     : ${taskId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`sha-before : ${parsedBefore.lastIndexedSha?.slice(0, 12)}`);
console.log(`\nRunning warm memory stage...\n`);

const noopTelegram = async () => {};
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
  const stateAfter = await readFile(statePath, "utf8");
  const parsedAfter = JSON.parse(stateAfter);
  const zonesHashAfter = await readFile(zonesPath, "utf8")
    .then((c) => createHash("sha256").update(c).digest("hex"))
    .catch(() => null);

  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${parsedAfter.zones?.length ?? 0}`);
  console.log(`sha-before : ${parsedBefore.lastIndexedSha?.slice(0, 12)}`);
  console.log(`sha-after  : ${parsedAfter.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${parsedAfter.lastIndexedAt}`);
  console.log(
    `.zones.json: ${zonesHashBefore === zonesHashAfter ? "untouched (correct)" : "MODIFIED -- invariant violation"}`,
  );
} catch {
  console.error(`Could not read .state.json after warm run -- warm run may have failed.`);
}
