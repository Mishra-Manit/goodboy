/**
 * Manual warm-patch test driver for the memory pipeline.
 * Usage: npx tsx scripts/dev/run-memory-warm.ts <repo-name> <TEST-instance-id>
 *
 * Reuses the memory directory created by run-memory-cold.ts. The instance ID
 * must be the TEST-prefixed value printed by the cold runner.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TEST_INSTANCE_PREFIX, isTestInstance } from "../../src/shared/test-instance.js";

const [, , repoName, instanceId] = process.argv;
if (!repoName || !instanceId) {
  console.error(
    `Usage: npx tsx scripts/dev/run-memory-warm.ts <repo-name> <${TEST_INSTANCE_PREFIX}instance-id>`,
  );
  process.exit(1);
}
if (!isTestInstance(instanceId)) {
  console.error(`instance-id must start with ${TEST_INSTANCE_PREFIX}. Got: ${instanceId}`);
  process.exit(1);
}

// Set BEFORE importing the common module so loadEnv picks up the test ID.
process.env["INSTANCE_ID"] = instanceId;

const { prepareMemoryTest, runMemoryTest, printBanner } = await import("./_memory-test-common.js");

const ctx = await prepareMemoryTest({ repoName, instanceId, kind: "warm" });

let stateBefore: string;
try {
  stateBefore = await readFile(ctx.statePath, "utf8");
} catch {
  console.error(
    `No .state.json found at ${ctx.statePath}.\nRun the cold script first:\n  npm run test:memory:cold -- ${repoName}`,
  );
  process.exit(1);
}

const zonesHashBefore = await readFile(ctx.zonesPath, "utf8")
  .then((c) => createHash("sha256").update(c).digest("hex"))
  .catch(() => null);

const parsedBefore = JSON.parse(stateBefore);
const shaBefore = parsedBefore.lastIndexedSha?.slice(0, 12) ?? "?";

printBanner("MEMORY WARM-PATCH TEST", ctx, { "sha-before": shaBefore });
console.log(`\nRunning warm memory stage...\n`);

await runMemoryTest(ctx);

try {
  const stateAfter = await readFile(ctx.statePath, "utf8");
  const parsedAfter = JSON.parse(stateAfter);
  const zonesHashAfter = await readFile(ctx.zonesPath, "utf8")
    .then((c) => createHash("sha256").update(c).digest("hex"))
    .catch(() => null);

  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${parsedAfter.zones?.length ?? 0}`);
  console.log(`sha-before : ${shaBefore}`);
  console.log(`sha-after  : ${parsedAfter.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${parsedAfter.lastIndexedAt}`);
  console.log(
    `.zones.json: ${zonesHashBefore === zonesHashAfter ? "untouched (correct)" : "MODIFIED -- invariant violation"}`,
  );
} catch {
  console.error(`Could not read .state.json after warm run -- warm run may have failed.`);
}
