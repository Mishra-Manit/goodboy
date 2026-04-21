/**
 * Dump every span the bridge emits with ids + parent ids + start/end
 * times, so we can verify nesting structure AND time-alignment before
 * trusting Logfire's renderer.
 */

import "dotenv/config";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { context, trace } from "@opentelemetry/api";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getTracer } from "../src/observability/tracer.js";
import { bridgeSessionToOtel } from "../src/observability/bridge/index.js";
import { Goodboy, GenAi } from "../src/observability/attributes.js";

class DumpExporter implements SpanExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    for (const s of spans) this.spans.push(s);
    cb({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
}

const taskDir = process.argv[2];
if (!taskDir) {
  console.error("usage: tsx scripts/bridge-dump.ts <taskDir>");
  process.exit(1);
}

function bounds(sessionPath: string): { first: number; last: number } | null {
  const lines = readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
  let first = Infinity;
  let last = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { message?: { timestamp?: number } };
      const ts = e.message?.timestamp;
      if (typeof ts !== "number") continue;
      if (ts < first) first = ts;
      if (ts > last) last = ts;
    } catch { /* ignore */ }
  }
  if (!Number.isFinite(first)) return null;
  return { first, last };
}

const exporter = new DumpExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

async function main() {
  const tracer = getTracer();
  const stages = ["planner"] as const;
  const sessionPath = path.join(taskDir, `${stages[0]}.session.jsonl`);
  if (!existsSync(sessionPath)) { console.error("missing:", sessionPath); process.exit(1); }
  const b = bounds(sessionPath)!;

  const pipeline = tracer.startSpan("goodboy.pipeline.coding_task",
    { attributes: { [Goodboy.TaskId]: "dump" }, startTime: b.first });
  const pipeCtx = trace.setSpan(context.active(), pipeline);
  const stage = tracer.startSpan("goodboy.stage.planner",
    { attributes: { [GenAi.System]: "pi" }, startTime: b.first },
    pipeCtx);

  const stageCtx = trace.setSpan(context.active(), stage);
  await context.with(stageCtx, async () => {
    const stop = bridgeSessionToOtel({ sessionPath, stageSpan: stage, taskId: "dump" });
    await new Promise((r) => setTimeout(r, 2000));
    stop();
  });
  stage.end(b.last);
  pipeline.end(b.last);

  await provider.shutdown();

  const byId = new Map<string, ReadableSpan>();
  for (const s of exporter.spans) byId.set(s.spanContext().spanId, s);
  console.log(`Total spans: ${exporter.spans.length}\n`);
  for (const s of exporter.spans) {
    const id = s.spanContext().spanId;
    const pid = s.parentSpanContext?.spanId ?? "ROOT";
    const parentName = byId.get(pid)?.name ?? (pid === "ROOT" ? "ROOT" : "??");
    const startMs = s.startTime[0] * 1000 + s.startTime[1] / 1e6;
    const endMs = s.endTime[0] * 1000 + s.endTime[1] / 1e6;
    const dur = (endMs - startMs).toFixed(0);
    console.log(
      `${s.name.padEnd(48)} p=${parentName.slice(0, 25).padEnd(25)} start=${new Date(startMs).toISOString().slice(11, 19)} dur=${dur}ms`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
