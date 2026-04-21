/**
 * Full-pipeline replay smoke. Spins up a pipeline + 3 stage spans whose
 * start/end times are aligned to the first/last timestamps of each pi
 * session JSONL. This is the key to getting a proper nested waterfall
 * when replaying historical sessions into Logfire -- without alignment,
 * the parent spans live in "now" but the bridge emits children at the
 * JSONL's historical timestamps, which renders as a broken tree.
 *
 * Production never needs this because live pi sessions and the stage
 * wrapper share the same wall clock.
 *
 * Usage: tsx scripts/bridge-smoke-full.ts <artifacts/taskDir>
 */

import "dotenv/config";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { initObservability, shutdownObservability } from "../src/observability/logfire.js";
import { getTracer } from "../src/observability/tracer.js";
import { bridgeSessionToOtel } from "../src/observability/bridge/index.js";
import { Goodboy, GenAi } from "../src/observability/attributes.js";
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

interface SessionBounds { first: number; last: number }

function bounds(sessionPath: string): SessionBounds | null {
  const lines = readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
  let first = Infinity;
  let last = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { message?: { timestamp?: number }; timestamp?: string };
      const ts = e.message?.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : undefined);
      if (typeof ts !== "number" || Number.isNaN(ts)) continue;
      if (ts < first) first = ts;
      if (ts > last) last = ts;
    } catch { /* ignore */ }
  }
  if (!Number.isFinite(first) || last === 0) return null;
  return { first, last };
}

async function main() {
  initObservability();
  const tracer = getTracer();
  const taskId = `smoke-${path.basename(taskDir)}`;

  // Compute pipeline bounds = union of all stage bounds.
  const stageBounds = STAGES
    .map(({ stage }) => ({ stage, b: bounds(path.join(taskDir, `${stage}.session.jsonl`)) }))
    .filter((x): x is { stage: StageName; b: SessionBounds } => x.b !== null);
  if (stageBounds.length === 0) {
    console.error("no session files found");
    process.exit(1);
  }
  const pipeFirst = Math.min(...stageBounds.map((s) => s.b.first));
  const pipeLast = Math.max(...stageBounds.map((s) => s.b.last));

  const pipelineSpan = tracer.startSpan(
    "goodboy.pipeline.coding_task",
    {
      attributes: {
        [Goodboy.TaskId]: taskId,
        [Goodboy.PipelineKind]: "coding_task",
        [Goodboy.Repo]: "smoke/replay",
        [GenAi.ConversationId]: taskId,
      },
      startTime: pipeFirst,
    },
  );
  const pipelineCtx = trace.setSpan(context.active(), pipelineSpan);

  for (const { stage, b } of stageBounds) {
    const sessionPath = path.join(taskDir, `${stage}.session.jsonl`);
    if (!existsSync(sessionPath)) continue;
    const label = STAGES.find((s) => s.stage === stage)?.label ?? stage;

    const stageSpan = tracer.startSpan(
      `goodboy.stage.${stage}`,
      {
        attributes: {
          [Goodboy.TaskId]: taskId,
          [Goodboy.Stage]: stage,
          [Goodboy.PiSessionPath]: sessionPath,
          [GenAi.AgentName]: label,
          [GenAi.RequestModel]: "replay",
          [GenAi.System]: "pi",
        },
        startTime: b.first,
      },
      pipelineCtx,
    );

    // Parent the bridge spans under this stage.
    const stageCtx = trace.setSpan(context.active(), stageSpan);
    await context.with(stageCtx, async () => {
      const stop = bridgeSessionToOtel({ sessionPath, stageSpan, taskId });
      // Let the tail watcher drain the file.
      await new Promise((r) => setTimeout(r, 3000));
      stop();
    });

    stageSpan.setStatus({ code: SpanStatusCode.OK });
    stageSpan.end(b.last);
  }

  pipelineSpan.setStatus({ code: SpanStatusCode.OK });
  pipelineSpan.end(pipeLast);

  await shutdownObservability();
  console.log(`smoke complete; look for goodboy.task_id='${taskId}' in Logfire`);
}

main().catch((e) => { console.error(e); process.exit(1); });
