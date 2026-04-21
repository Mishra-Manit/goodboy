/**
 * End-to-end smoke: boot Logfire for real, open a pipeline + stage span,
 * run the bridge against an existing pi session JSONL, flush, shut down.
 * Spans land in the Logfire project that owns `LOGFIRE_TOKEN`.
 *
 * Usage: tsx scripts/bridge-smoke.ts <path/to/session.jsonl>
 */

import "dotenv/config";
import {
  initObservability,
  shutdownObservability,
  withPipelineSpan,
  withStageSpan,
  bridgeSessionToOtel,
} from "../src/observability/index.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/bridge-smoke.ts <session.jsonl>");
  process.exit(1);
}

async function main() {
  initObservability();

  await withPipelineSpan(
    { taskId: "smoke-task", kind: "coding_task", repo: "smoke/repo" },
    async () => {
      await withStageSpan(
        {
          taskId: "smoke-task",
          stage: "planner",
          model: "smoke-model",
          stageLabel: "Planner (smoke)",
          piSessionPath: path,
        },
        async (stageSpan) => {
          const stop = bridgeSessionToOtel({ sessionPath: path, stageSpan, taskId: "smoke-task" });
          // Give the poll loop enough wall-clock to chew through the whole file.
          await new Promise((r) => setTimeout(r, 3000));
          stop();
        },
      );
    },
  );

  await shutdownObservability();
  console.log("smoke complete; check Logfire for task_id='smoke-task'");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
