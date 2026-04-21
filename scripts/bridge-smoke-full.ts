/**
 * Full-pipeline smoke: one pipeline span with three stage spans, each
 * bridged to a real pi session JSONL from a past coding task. Gives you
 * a complete waterfall in Logfire that matches what a live run produces.
 *
 * Usage: tsx scripts/bridge-smoke-full.ts <artifacts/taskDir>
 */

import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  initObservability,
  shutdownObservability,
  withPipelineSpan,
  withStageSpan,
  bridgeSessionToOtel,
} from "../src/observability/index.js";
import type { StageName } from "../src/shared/types.js";

const taskDir = process.argv[2];
if (!taskDir) {
  console.error("usage: tsx scripts/bridge-smoke-full.ts <artifacts/taskDir>");
  process.exit(1);
}

const STAGES: { stage: StageName; label: string }[] = [
  { stage: "planner", label: "Planner" },
  { stage: "implementer", label: "Implementer" },
  { stage: "reviewer", label: "Reviewer" },
];

async function main() {
  initObservability();
  const taskId = `smoke-${path.basename(taskDir)}`;

  await withPipelineSpan(
    { taskId, kind: "coding_task", repo: "smoke/replay" },
    async () => {
      for (const { stage, label } of STAGES) {
        const sessionPath = path.join(taskDir, `${stage}.session.jsonl`);
        if (!existsSync(sessionPath)) {
          console.warn(`skip ${stage}: ${sessionPath} not found`);
          continue;
        }
        await withStageSpan(
          { taskId, stage, model: "replay", stageLabel: label, piSessionPath: sessionPath },
          async (stageSpan) => {
            const stop = bridgeSessionToOtel({ sessionPath, stageSpan, taskId });
            await new Promise((r) => setTimeout(r, 3000));
            stop();
          },
        );
      }
    },
  );

  await shutdownObservability();
  console.log(`smoke complete; look for task_id='${taskId}' in Logfire`);
}

main().catch((e) => { console.error(e); process.exit(1); });
