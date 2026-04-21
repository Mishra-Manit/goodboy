import "dotenv/config";
import { initObservability, shutdownObservability, withPipelineSpan, withStageSpan } from "../src/observability/index.js";

async function main() {
  initObservability();
  await withPipelineSpan(
    { taskId: "smoke-test-123", kind: "coding", repo: "test/repo" },
    async () => {
      await withStageSpan(
        { taskId: "smoke-test-123", stage: "planner", model: "test/model",
          stageLabel: "Planner", piSessionPath: "/tmp/fake.jsonl" },
        async () => {
          console.log("inside stage span");
          await new Promise((r) => setTimeout(r, 100));
        },
      );
    },
  );
  await shutdownObservability();
  console.log("smoke complete");
}

main().catch((e) => { console.error(e); process.exit(1); });
