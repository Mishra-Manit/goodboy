/**
 * Shared scaffolding for the manual memory test drivers (cold, warm).
 *
 * Import this module DYNAMICALLY after the driver has set
 * `process.env["INSTANCE_ID"]`. Static imports would trigger `loadEnv` with
 * the wrong instance ID cached, because every downstream module reads env
 * at first use.
 */

export interface MemoryTestContext {
  repoName: string;
  repoPath: string;
  instanceId: string;
  taskId: string;
  memoryDirPath: string;
  statePath: string;
  zonesPath: string;
}

/**
 * Resolve paths and verify the repo is registered. Exits the process on
 * unknown repo so the driver never has to null-check the context.
 */
export async function prepareMemoryTest(args: {
  repoName: string;
  instanceId: string;
  kind: "cold" | "warm";
}): Promise<MemoryTestContext> {
  const { getRepo } = await import("../../src/shared/repos.js");
  const { memoryDir, memoryStatePath, zonesSidecarPath } = await import(
    "../../src/core/memory/index.js"
  );

  const repo = getRepo(args.repoName);
  if (!repo) {
    console.error(`Unknown repo: ${args.repoName}. Check REGISTERED_REPOS.`);
    process.exit(1);
  }

  return {
    repoName: args.repoName,
    repoPath: repo.localPath,
    instanceId: args.instanceId,
    taskId: `${args.instanceId}-${args.kind}`,
    memoryDirPath: memoryDir(args.repoName),
    statePath: memoryStatePath(args.repoName),
    zonesPath: zonesSidecarPath(args.repoName),
  };
}

/**
 * Run the memory pipeline with a no-op Telegram. Always shuts observability
 * down, even if the pipeline throws (it shouldn't -- runMemory soft-fails).
 */
export async function runMemoryTest(ctx: MemoryTestContext): Promise<void> {
  const { runMemory } = await import("../../src/pipelines/memory/pipeline.js");
  const { initObservability, shutdownObservability } = await import(
    "../../src/observability/index.js"
  );

  initObservability();
  try {
    await runMemory({
      taskId: ctx.taskId,
      repo: ctx.repoName,
      repoPath: ctx.repoPath,
      source: "manual_test",
      sendTelegram: async () => {},
      chatId: null,
    });
  } finally {
    await shutdownObservability();
  }
}

/** Print the standard 5-row setup banner. Extras append as "key : value" rows. */
export function printBanner(
  label: string,
  ctx: MemoryTestContext,
  extras: Record<string, string> = {},
): void {
  console.log(`\n=== ${label} ===`);
  console.log(`repo       : ${ctx.repoName}`);
  console.log(`instanceId : ${ctx.instanceId}`);
  console.log(`taskId     : ${ctx.taskId}`);
  console.log(`memoryDir  : ${ctx.memoryDirPath}`);
  console.log(`repoPath   : ${ctx.repoPath}`);
  for (const [k, v] of Object.entries(extras)) {
    console.log(`${k.padEnd(11)}: ${v}`);
  }
}
