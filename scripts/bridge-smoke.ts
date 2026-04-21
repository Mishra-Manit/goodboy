/**
 * End-to-end smoke for the observability bridge: spin up Logfire with a
 * ConsoleSpanExporter, open a stage span, point the bridge at an existing
 * pi session JSONL, wait for the tail-watcher to read the whole file,
 * then flush and shut down. Prints every emitted span to stdout.
 */

import "dotenv/config";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { bridgeSessionToOtel } from "../src/observability/bridge/index.js";
import { withPipelineSpan, withStageSpan } from "../src/observability/index.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/bridge-smoke.ts <session.jsonl>");
  process.exit(1);
}

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
provider.register();

async function main() {
  await withPipelineSpan(
    { taskId: "smoke-task", kind: "coding_task", repo: "smoke/repo" },
    async () => {
      await withStageSpan(
        {
          taskId: "smoke-task",
          stage: "planner",
          model: "smoke-model",
          stageLabel: "Planner",
          piSessionPath: path,
        },
        async (stageSpan) => {
          const stop = bridgeSessionToOtel({ sessionPath: path, stageSpan, taskId: "smoke-task" });
          // Give the poll loop time to chew through the whole file.
          await new Promise((r) => setTimeout(r, 2000));
          stop();
        },
      );
    },
  );
  await provider.shutdown();
}

main().catch((e) => { console.error(e); process.exit(1); });
