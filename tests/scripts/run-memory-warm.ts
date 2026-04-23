/**
 * Manual warm-patch test driver for the memory pipeline.
 * Usage: npx tsx tests/scripts/run-memory-warm.ts <test-label> <repo-name> <TEST-instance-id>
 *
 * Reuses the memory directory created by run-memory-cold.ts. The instance ID
 * must be the TEST-prefixed value printed by the cold runner.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [, , testLabel, repoName, instanceId] = process.argv;
if (!testLabel || !repoName || !instanceId) {
  console.error(
    "Usage: npx tsx tests/scripts/run-memory-warm.ts <test-label> <repo-name> <TEST-instance-id>",
  );
  process.exit(1);
}
if (!instanceId.startsWith("TEST-")) {
  console.error(`instance-id must start with TEST-. Got: ${instanceId}`);
  process.exit(1);
}

process.env["INSTANCE_ID"] = instanceId;

const { getRepo } = await import("../../src/shared/repos.js");
const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
const { memoryDir, memoryStatePath, zonesSidecarPath } = await import("../../src/core/memory/index.js");

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
    `No .state.json found at ${statePath}.\nRun the cold script first:\n  npm run test:memory:cold -- ${testLabel} ${repoName}`,
  );
  process.exit(1);
}

const zonesPath = zonesSidecarPath(repoName);
const zonesHashBefore = await readFile(zonesPath, "utf8")
  .then((c) => createHash("sha256").update(c).digest("hex"))
  .catch(() => null);

const parsedBefore = JSON.parse(stateBefore);

console.log(`\n=== MEMORY WARM-PATCH TEST ===`);
console.log(`label      : ${testLabel}`);
console.log(`repo       : ${repoName}`);
console.log(`instanceId : ${instanceId}`);
console.log(`memoryDir  : ${memoryDir(repoName)}`);
console.log(`repoPath   : ${repo.localPath}`);
console.log(`sha-before : ${parsedBefore.lastIndexedSha?.slice(0, 12)}`);
console.log(`\nRunning warm memory stage...\n`);

const noopTelegram = async () => {};
await runMemory({
  taskId: `${testLabel}-warm`,
  repo: repoName,
  repoPath: repo.localPath,
  sendTelegram: noopTelegram,
  chatId: null,
});

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
