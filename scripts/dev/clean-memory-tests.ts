/** Manual cleanup for memory test runs. */

import "dotenv/config";

const { cleanupTestMemoryRuns } = await import("../../src/core/memory/cleanup.js");

const result = await cleanupTestMemoryRuns();

console.log(`Deleted ${result.deletedRows} TEST memory_runs rows.`);
console.log(`Removed ${result.deletedTranscriptDirs} transcript directories.`);
console.log(`Removed ${result.deletedMemoryDirs} memory-TEST-* directories.`);
