/**
 * Manual cold-start test driver for the memory pipeline.
 * Usage: npx tsx scripts/dev/run-memory-cold.ts <repo-name>
 *
 * Generates a TEST-prefixed instance ID so artifacts stay isolated from
 * production memory. Prints the instance ID at the end for reuse with
 * run-memory-warm.ts.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TEST_INSTANCE_PREFIX } from "../../src/shared/domain/test-instance.js";

const [, , repoName] = process.argv;
if (!repoName) {
  console.error("Usage: npx tsx scripts/dev/run-memory-cold.ts <repo-name>");
  process.exit(1);
}

// Set BEFORE importing the common module so loadEnv picks up the test ID.
const instanceId = `${TEST_INSTANCE_PREFIX}${randomBytes(4).toString("hex")}`;
process.env["INSTANCE_ID"] = instanceId;

const { prepareMemoryTest, runMemoryTest, printBanner } = await import("./_memory-test-common.js");

const ctx = await prepareMemoryTest({ repoName, instanceId, kind: "cold" });

printBanner("MEMORY COLD-START TEST", ctx);
console.log(`\nRunning cold memory stage...\n`);

await runMemoryTest(ctx);

try {
  const state = JSON.parse(await readFile(ctx.statePath, "utf8"));
  console.log(`\n=== RESULT ===`);
  console.log(`zones      : ${state.zones?.length ?? 0}`);
  console.log(`sha        : ${state.lastIndexedSha?.slice(0, 12)}`);
  console.log(`indexedAt  : ${state.lastIndexedAt}`);
} catch {
  console.error(`No .state.json found -- cold run may have failed.`);
}

console.log(`\nTo test warm, run:`);
console.log(`  npm run test:memory:warm -- ${repoName} ${instanceId}\n`);
