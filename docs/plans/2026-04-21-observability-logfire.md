# Observability (Logfire + pi JSONL → OTel Bridge) Implementation Plan

**Goal:** Ship every pi agent session from EC2 to Pydantic Logfire as an OTel span tree (pipeline → stage → assistant turn → tool call), so task timing, token usage, cost, tool-call waterfalls, and failure reasons are all queryable.

**Approach:** Put the entire implementation under `src/observability/`. One-time Logfire init on boot. Two span layers: (A) manual spans in `core/stage.ts` and each pipeline wrap the task/stage timeline; (B) a JSONL bridge tails pi's session files and translates each `message`/`toolCall`/`toolResult` entry into OTel GenAI-semconv spans nested under the active stage span. Everything else (DB, SSE, text logs) stays exactly as it is.

**Stack:** `@pydantic/logfire-node` (OTel wrapper, ships to `https://logfire-us.pydantic.dev`), `@opentelemetry/api` (context propagation + span access), pi's native session JSONL (`src/shared/session.ts` schema, tailed by `src/core/session-file.ts#watchSessionFile`).

---

## Design decisions (locked before we start)

1. **One trace per user-visible unit of work.** A coding task is one trace: root span `goodboy.pipeline.coding`; child spans `goodboy.stage.planner / implementer / reviewer`; grand-children are pi's assistant turns and tool calls. Question pipeline, PR-review, and PR-session runs each get their own root trace. PR sessions span multiple rounds; each round is its own trace, linked via `goodboy.pr_session.id` attribute.
2. **Logfire is the backend, but the code is OTel-native.** We call `logfire.configure()` once; everywhere else we use `@opentelemetry/api`. Swapping to Langfuse / Phoenix / self-hosted later is a config change, not a code change.
3. **`distributedTracing: false`.** Goodboy is not the downstream of any traced caller; accepting inbound traceparent headers would let a hostile Telegram message spoof a trace. Off.
4. **`sendToLogfire: "if-token-present"`.** No token → no-op. Dev machines stay silent unless the dev explicitly sets `LOGFIRE_TOKEN`.
5. **Bridge runs per stage, not globally.** The bridge is scoped to the stage span so there's no global subscriber lifecycle to manage. When `runStage` ends, the bridge is disposed.
6. **Bridge is pure parser + thin OTel adapter.** The `FileEntry` → `SpanCommand` mapping is a pure function; a separate adapter consumes commands and calls `tracer.startSpan` / `span.end`. Matches the "pure parsers separated from IO" rule in `AGENTS.md` and makes the translator testable without OTel.
7. **Attributes follow OTel GenAI semantic conventions.** `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.response.finish_reasons`. Goodboy-specific things (task id, stage, repo, cost in USD) go under `goodboy.*`.
8. **Assistant prompt/response content is captured as span events, not attributes.** Events don't bloat the attribute index, and Logfire renders them inline. Thinking blocks also become events.
9. **Cost tracking.** Pi's session already computes `usage.cost.total` per assistant message. We sum it into `goodboy.cost_usd` on the parent stage span via `span.addEvent` + a running accumulator kept in the bridge. No extra LLM math on our side.
10. **Graceful shutdown.** On `SIGINT`/`SIGTERM` we call `trace.getTracerProvider().forceFlush()` then `.shutdown()` before `process.exit`. Without this, BatchSpanProcessor drops queued spans on systemd restart (documented failure mode).

---

## Final file layout

```
src/observability/
  index.ts                 # public API surface
  logfire.ts               # configure() + shutdown
  tracer.ts                # getTracer() singleton, constants
  attributes.ts            # attribute-name constants + attribute builders
  spans.ts                 # withPipelineSpan / withStageSpan helpers
  bridge/
    index.ts               # bridgeSessionToOtel (IO wrapper)
    translate.ts           # pure: FileEntry -> SpanCommand[]
    types.ts               # SpanCommand discriminated union
  README.md                # what this module is, how to look at traces
docs/plans/
  2026-04-21-observability-logfire.md   # this file
```

No files outside `src/observability/` gain imports from `@pydantic/logfire-node` or `@opentelemetry/*`; they import from `src/observability/index.js` only. That keeps the blast radius of a backend swap to one directory.

---

## Tasks

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

**Implementation:**

Install:

```
npm install @pydantic/logfire-node @opentelemetry/api
```

`@opentelemetry/api` is already a transitive dep but install it explicitly so we can import `trace`, `context`, `SpanStatusCode` without relying on hoisting.

No changes to `src/shared/config.ts`. `LOGFIRE_TOKEN` is read directly from `process.env` inside `src/observability/logfire.ts` — it's consumed in exactly one place and doesn't belong in the shared env contract. If the token is missing, the Logfire SDK is a no-op thanks to `sendToLogfire: "if-token-present"`, so no separate kill switch is needed.

Add to `.env.example`:

```
# Observability (optional; unset the token to disable)
LOGFIRE_TOKEN=
```

**Verify:**
`npm run build` exits 0.

**Commit:** `chore: add logfire + otel-api dependencies`

---

### Task 2: Logfire init + graceful shutdown

**Files:**
- Create: `src/observability/logfire.ts`
- Create: `src/observability/tracer.ts`

**Implementation:**

`src/observability/tracer.ts`:

```ts
/**
 * Central tracer accessor. Everything in src/observability uses this so
 * there is one OTel scope name (`goodboy`) in every emitted span.
 */

import { trace, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "goodboy";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
```

`src/observability/logfire.ts`:

```ts
/**
 * One-shot Logfire initialization. Called from src/index.ts before any
 * pipeline boots. `configure()` is idempotent but we guard anyway so
 * hot-reload in dev doesn't double-register span processors.
 *
 * Graceful shutdown is critical: BatchSpanProcessor keeps spans in memory
 * and will drop them on SIGTERM unless we forceFlush + shutdown first.
 */

import * as logfire from "@pydantic/logfire-node";
import { trace } from "@opentelemetry/api";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("observability");

let _initialized = false;

export function initObservability(): void {
  if (_initialized) return;
  const env = loadEnv();
  const token = process.env.LOGFIRE_TOKEN;
  logfire.configure({
    token,
    sendToLogfire: "if-token-present",
    serviceName: "goodboy",
    environment: env.INSTANCE_ID,
    distributedTracing: false,
  });
  _initialized = true;
  log.info(token ? `Logfire enabled (environment=${env.INSTANCE_ID})` : "LOGFIRE_TOKEN unset; spans will be dropped");
}

/** Flush and shut down the OTel provider. Call from SIGINT/SIGTERM. */
export async function shutdownObservability(): Promise<void> {
  if (!_initialized) return;
  const provider = trace.getTracerProvider() as unknown as {
    forceFlush?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  };
  try { await provider.forceFlush?.(); } catch (err) { log.warn(`forceFlush failed: ${String(err)}`); }
  try { await provider.shutdown?.(); } catch (err) { log.warn(`shutdown failed: ${String(err)}`); }
}
```

**Verify:**
Write a throwaway script `scripts/smoke-logfire.ts` that imports and calls `initObservability()`, creates one span with `getTracer().startActiveSpan("smoke", (s) => s.end())`, then calls `shutdownObservability()`. Run with a real `LOGFIRE_TOKEN` and confirm the span appears in the Logfire Live view.

**Commit:** `feat(observability): logfire init and graceful shutdown`

---

### Task 3: Attribute constants and span helpers

**Files:**
- Create: `src/observability/attributes.ts`
- Create: `src/observability/spans.ts`
- Create: `src/observability/index.ts`

**Implementation:**

`src/observability/attributes.ts`:

```ts
/**
 * All attribute names used in goodboy spans. Split into OTel GenAI
 * semantic conventions and goodboy-specific keys so consumers can tell
 * them apart at a glance.
 *
 * Ref: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */

export const GenAi = {
  System: "gen_ai.system",
  OperationName: "gen_ai.operation.name",
  RequestModel: "gen_ai.request.model",
  ResponseModel: "gen_ai.response.model",
  ResponseFinishReasons: "gen_ai.response.finish_reasons",
  UsageInputTokens: "gen_ai.usage.input_tokens",
  UsageOutputTokens: "gen_ai.usage.output_tokens",
  UsageCacheReadTokens: "gen_ai.usage.cache_read_tokens",
  UsageCacheWriteTokens: "gen_ai.usage.cache_write_tokens",
  ToolName: "gen_ai.tool.name",
  ToolCallId: "gen_ai.tool.call.id",
  AgentName: "gen_ai.agent.name",
  ConversationId: "gen_ai.conversation.id",
} as const;

export const Goodboy = {
  TaskId: "goodboy.task_id",
  Stage: "goodboy.stage",
  PipelineKind: "goodboy.pipeline.kind",
  Repo: "goodboy.repo",
  Branch: "goodboy.branch",
  PrSessionId: "goodboy.pr_session.id",
  PrSessionRunId: "goodboy.pr_session.run_id",
  PrNumber: "goodboy.pr.number",
  CostUsd: "goodboy.cost_usd",
  ToolArgs: "goodboy.tool.args",       // truncated JSON
  ToolOutput: "goodboy.tool.output",   // truncated text
  ToolIsError: "goodboy.tool.is_error",
  StopReason: "goodboy.stop_reason",
  PiSessionPath: "goodboy.pi_session_path",
} as const;

export const MAX_ATTR_STRING = 8 * 1024; // 8 KiB truncation budget per attribute

export function truncate(s: string, max = MAX_ATTR_STRING): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max}b]`;
}
```

`src/observability/spans.ts`:

```ts
/**
 * High-level span helpers. Every pipeline calls `withPipelineSpan` at its
 * top and `core/stage.ts` calls `withStageSpan` for each stage. Both are
 * thin wrappers around `tracer.startActiveSpan` that (a) pre-populate the
 * goodboy attribute set, (b) set span status from the callback's outcome,
 * (c) always end the span.
 */

import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { getTracer } from "./tracer.js";
import { GenAi, Goodboy } from "./attributes.js";
import type { StageName, TaskKind } from "../shared/types.js";

export interface PipelineSpanContext {
  taskId: string;
  kind: TaskKind;
  repo?: string;
  branch?: string;
}

export async function withPipelineSpan<T>(
  ctx: PipelineSpanContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(`goodboy.pipeline.${ctx.kind}`, {
    attributes: {
      [Goodboy.TaskId]: ctx.taskId,
      [Goodboy.PipelineKind]: ctx.kind,
      ...(ctx.repo ? { [Goodboy.Repo]: ctx.repo } : {}),
      ...(ctx.branch ? { [Goodboy.Branch]: ctx.branch } : {}),
      [GenAi.ConversationId]: ctx.taskId,
    },
  }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface StageSpanContext {
  taskId: string;
  stage: StageName;
  model: string;
  stageLabel: string;
  piSessionPath: string;
}

export async function withStageSpan<T>(
  ctx: StageSpanContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(`goodboy.stage.${ctx.stage}`, {
    attributes: {
      [Goodboy.TaskId]: ctx.taskId,
      [Goodboy.Stage]: ctx.stage,
      [Goodboy.PiSessionPath]: ctx.piSessionPath,
      [GenAi.AgentName]: ctx.stageLabel,
      [GenAi.RequestModel]: ctx.model,
      [GenAi.System]: "pi",
    },
  }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

`src/observability/index.ts`:

```ts
/**
 * Public surface of the observability module. Other modules import only
 * from here; no file outside src/observability/ imports Logfire or the
 * raw OTel API.
 */

export { initObservability, shutdownObservability } from "./logfire.js";
export { withPipelineSpan, withStageSpan } from "./spans.js";
export { bridgeSessionToOtel } from "./bridge/index.js";
```

**Verify:**
`npm run build` passes. Nothing calls the helpers yet.

**Commit:** `feat(observability): attribute constants and pipeline/stage span helpers`

---

### Task 4: Wire init + shutdown into the process entry point

**Files:**
- Modify: `src/index.ts`

**Implementation:**

Import and call `initObservability()` as the very first thing in `main()` (before `loadEnv()` — init itself calls `loadEnv`). Add `shutdownObservability()` to the `shutdown` function before `process.exit(0)`.

```ts
import { initObservability, shutdownObservability } from "./observability/index.js";

async function main(): Promise<void> {
  initObservability();                // <-- add
  const env = loadEnv();
  // ...existing body...
      const shutdown = async (): Promise<void> => {
        log.info("Shutting down...");
        stopPrPoller();
        await telegramBot.stop();
        server.close();
        await shutdownObservability(); // <-- add
        process.exit(0);
      };
```

Also add `await shutdownObservability()` to the `unhandledRejection` handler before `process.exit(1)` so we at least try to flush on a crash:

```ts
process.on("unhandledRejection", async (reason) => {
  log.error("Unhandled rejection", reason);
  await shutdownObservability().catch(() => {});
  process.exit(1);
});
```

**Verify:**
`npm run dev`, send Telegram message, observe nothing changes behaviorally. `Ctrl-C` cleanly shuts down. With `LOGFIRE_CONSOLE=true` set, confirm the test smoke span from Task 2 flushes before exit.

**Commit:** `feat(observability): wire init and graceful shutdown into main`

---

### Task 5: Wrap runStage with withStageSpan

**Files:**
- Modify: `src/core/stage.ts`

**Implementation:**

Change the body of `runStage` so everything from `queries.updateTask({status:"running"})` through the `finally` block runs inside `withStageSpan`. The span must be the parent for the bridge (Task 7), so the bridge call goes inside the callback. Rough shape:

```ts
import { withStageSpan } from "../observability/index.js";
import { Goodboy } from "../observability/attributes.js"; // if attaching post-hoc attrs

// inside runStage:
return withStageSpan(
  { taskId, stage, model, stageLabel, piSessionPath: sessionPath },
  async (stageSpan) => {
    await queries.updateTask(taskId, { status: "running" });
    // ...existing body up through the try/catch/finally...
    // Inside finally, also call stopBridge() (added in Task 7).
  },
);
```

Keep all existing DB and SSE emits exactly where they are — they run inside the span, which is the whole point.

On pipeline-level failures, the stage span status is already set to ERROR by the helper's catch. No extra code.

**Verify:**
Trigger a task via Telegram, confirm a `goodboy.stage.*` span with a 30+ second duration and correct `goodboy.task_id` shows up in Logfire, still nested as a child of whatever pipeline span exists (none yet — that's Task 6).

**Commit:** `feat(observability): wrap every pi stage in an OTel span`

---

### Task 6: Wrap every pipeline entry in withPipelineSpan

**Files:**
- Modify: `src/pipelines/coding/pipeline.ts`
- Modify: `src/pipelines/question/pipeline.ts`
- Modify: `src/pipelines/pr-review/pipeline.ts`
- Modify: `src/pipelines/pr-session/session.ts` (3 entry points: `startPrSession`, `resumePrSession`, `startExternalReview`)

**Implementation pattern (apply to each):**

```ts
import { withPipelineSpan } from "../../observability/index.js";

export async function runPipeline(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) { /* unchanged */ return; }
  return withPipelineSpan(
    { taskId, kind: "coding", repo: task.repo },
    async () => {
      // existing body
    },
  );
}
```

For `pr-session` entry points, the `kind` is `"pr-session"` and add `prSessionId` via `span.setAttribute(Goodboy.PrSessionId, ...)` once known, plus `Goodboy.PrSessionRunId` on each round. Because a PR session runs in a loop listening for comments, each *round* is a separate trace — `withPipelineSpan` wraps one round, not the outer session. The poller in `poller.ts` stays untracked (periodic; uninteresting).

**Verify:**
Run one task of each kind, confirm Logfire shows one root trace per task with all stages nested underneath and correct `goodboy.pipeline.kind`, `goodboy.repo`, `goodboy.task_id` on the root.

**Commit:** `feat(observability): wrap pipeline entry points in root spans`

---

### Task 7: Pi JSONL → OTel bridge (pure translator)

**Files:**
- Create: `src/observability/bridge/types.ts`
- Create: `src/observability/bridge/translate.ts`

**Implementation:**

`src/observability/bridge/types.ts`:

```ts
/**
 * Commands emitted by the pure translator. The IO adapter in index.ts
 * turns these into OTel span operations. Kept as a discriminated union
 * so the translator is fully unit-testable without OTel.
 */

import type { SessionHeader } from "../../shared/session.js";

export type SpanCommand =
  | StartChatSpan
  | EndChatSpan
  | StartToolSpan
  | EndToolSpan
  | StageEvent
  | AccumulateCost;

export interface StartChatSpan {
  type: "chat.start";
  key: string;          // stable id; we use assistant message timestamp+index
  model: string;
  provider: string;
  api: string;
  startedAtMs: number;
}

export interface EndChatSpan {
  type: "chat.end";
  key: string;
  endedAtMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  stopReason: string;
  textPreview: string;        // first N chars of concatenated assistant text
  thinkingPreview?: string;   // concatenated thinking blocks (if any)
  errorMessage?: string;
}

export interface StartToolSpan {
  type: "tool.start";
  key: string;                // toolCall.id
  name: string;
  argsJson: string;           // already truncated
  startedAtMs: number;
  parentChatKey: string;      // bridge uses this to parent correctly
}

export interface EndToolSpan {
  type: "tool.end";
  key: string;                // toolCall.id
  endedAtMs: number;
  outputPreview: string;      // already truncated
  isError: boolean;
}

export interface StageEvent {
  type: "stage.event";
  name: string;               // "compaction" | "model_change" | "bash_execution" | ...
  attributes: Record<string, string | number | boolean>;
}

export interface AccumulateCost {
  type: "cost.add";
  usd: number;
}

export interface TranslatorState {
  sessionHeader?: SessionHeader;
  openChatKey: string | null;
  openToolIds: Set<string>;
}

export function initialState(): TranslatorState {
  return { openChatKey: null, openToolIds: new Set() };
}
```

`src/observability/bridge/translate.ts`:

```ts
/**
 * Pure FileEntry -> SpanCommand translator. No OTel, no IO, no fs. The
 * IO wrapper in ./index.ts subscribes to watchSessionFile and runs each
 * entry through `translate`, updating state and emitting commands.
 *
 * Every call is: (prevState, entry) -> (nextState, commands).
 */

import type { FileEntry, SessionMessageEntry, AssistantMessage, ToolResultMessage } from "../../shared/session.js";
import { truncate } from "../attributes.js";
import type { SpanCommand, TranslatorState } from "./types.js";

const MAX_PREVIEW = 2000;

export function translate(
  state: TranslatorState,
  entry: FileEntry,
): { state: TranslatorState; commands: SpanCommand[] } {
  if (entry.type === "session") {
    return { state: { ...state, sessionHeader: entry }, commands: [] };
  }
  if (entry.type === "message") {
    return handleMessage(state, entry);
  }
  if (entry.type === "model_change" || entry.type === "compaction" || entry.type === "branch_summary") {
    return {
      state,
      commands: [{
        type: "stage.event",
        name: entry.type,
        attributes: flattenAttrs(entry),
      }],
    };
  }
  return { state, commands: [] };
}

function handleMessage(state: TranslatorState, entry: SessionMessageEntry): { state: TranslatorState; commands: SpanCommand[] } {
  const m = entry.message;
  if (m.role === "assistant") return handleAssistant(state, entry, m);
  if (m.role === "toolResult") return handleToolResult(state, entry, m);
  if (m.role === "bashExecution") {
    return {
      state,
      commands: [{
        type: "stage.event",
        name: "bash_execution",
        attributes: {
          command: truncate(m.command, 512),
          exit_code: m.exitCode ?? -1,
          cancelled: m.cancelled,
        },
      }],
    };
  }
  // user / custom messages: ignored for span purposes.
  return { state, commands: [] };
}

function handleAssistant(state: TranslatorState, entry: SessionMessageEntry, m: AssistantMessage): { state: TranslatorState; commands: SpanCommand[] } {
  const key = entry.id;
  const commands: SpanCommand[] = [];

  commands.push({
    type: "chat.start",
    key,
    model: m.model,
    provider: m.provider,
    api: m.api,
    startedAtMs: m.timestamp,
  });

  // Extract text + thinking previews.
  const texts = m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map(b => b.text).join("\n");
  const thinkings = m.content.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking").map(b => b.thinking).join("\n");

  commands.push({
    type: "chat.end",
    key,
    endedAtMs: m.timestamp, // pi does not timestamp per-turn; start==end is fine, duration shows up via surrounding spans
    usage: {
      inputTokens: m.usage.input,
      outputTokens: m.usage.output,
      cacheReadTokens: m.usage.cacheRead,
      cacheWriteTokens: m.usage.cacheWrite,
      costUsd: m.usage.cost.total,
    },
    stopReason: m.stopReason,
    textPreview: truncate(texts, MAX_PREVIEW),
    thinkingPreview: thinkings ? truncate(thinkings, MAX_PREVIEW) : undefined,
    errorMessage: m.errorMessage,
  });

  // Start tool spans as children of the chat span.
  const openedToolIds = new Set(state.openToolIds);
  for (const block of m.content) {
    if (block.type !== "toolCall") continue;
    commands.push({
      type: "tool.start",
      key: block.id,
      name: block.name,
      argsJson: truncate(JSON.stringify(block.arguments)),
      startedAtMs: m.timestamp,
      parentChatKey: key,
    });
    openedToolIds.add(block.id);
  }

  commands.push({ type: "cost.add", usd: m.usage.cost.total });
  return { state: { ...state, openChatKey: key, openToolIds: openedToolIds }, commands };
}

function handleToolResult(state: TranslatorState, _entry: SessionMessageEntry, m: ToolResultMessage): { state: TranslatorState; commands: SpanCommand[] } {
  if (!state.openToolIds.has(m.toolCallId)) {
    // Result without a matching call -- skip silently; possible with pi replays.
    return { state, commands: [] };
  }
  const outputText = m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => b.text)
    .join("\n");
  const nextOpen = new Set(state.openToolIds);
  nextOpen.delete(m.toolCallId);
  return {
    state: { ...state, openToolIds: nextOpen },
    commands: [{
      type: "tool.end",
      key: m.toolCallId,
      endedAtMs: m.timestamp,
      outputPreview: truncate(outputText, MAX_PREVIEW),
      isError: m.isError,
    }],
  };
}

function flattenAttrs(entry: FileEntry): Record<string, string | number | boolean> {
  // Best-effort scalar extraction; arrays/objects become JSON strings.
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = truncate(JSON.stringify(v), 1024);
    }
  }
  return out;
}
```

**Verify:**
Write a tiny REPL harness in `scripts/translate-smoke.ts` that reads an existing session file from `artifacts/<taskId>/planner.session.jsonl`, folds `translate` over every entry, and prints the command stream. Eyeball it: each `chat.start` should be followed by a `chat.end` with non-zero tokens, tool starts should pair with tool ends.

**Commit:** `feat(observability): pure translator from pi session entries to span commands`

---

### Task 8: Bridge IO adapter

**Files:**
- Create: `src/observability/bridge/index.ts`

**Implementation:**

```ts
/**
 * Subscribes to a pi session file and turns entries into live OTel spans
 * nested under the current stage span. Returns a disposer; call it in
 * `runStage`'s finally block so we don't leak watchers.
 *
 * This is the IO half of the bridge -- all parsing lives in translate.ts.
 */

import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { watchSessionFile } from "../../core/session-file.js";
import { createLogger } from "../../shared/logger.js";
import { getTracer } from "../tracer.js";
import { GenAi, Goodboy, truncate } from "../attributes.js";
import { translate } from "./translate.js";
import { initialState, type SpanCommand, type TranslatorState } from "./types.js";

const log = createLogger("bridge");

export interface BridgeOptions {
  sessionPath: string;
  stageSpan: Span;
  taskId: string;
}

export function bridgeSessionToOtel({ sessionPath, stageSpan, taskId }: BridgeOptions): () => void {
  const tracer = getTracer();
  const chatSpans = new Map<string, Span>();
  const toolSpans = new Map<string, Span>();
  let state: TranslatorState = initialState();
  let totalCost = 0;

  // Everything we create parents off the stage span via a child context.
  const stageCtx = trace.setSpan(context.active(), stageSpan);

  function handle(cmd: SpanCommand): void {
    switch (cmd.type) {
      case "chat.start": {
        const span = tracer.startSpan(`gen_ai.chat ${cmd.model}`, {
          attributes: {
            [GenAi.System]: "pi",
            [GenAi.OperationName]: "chat",
            [GenAi.RequestModel]: cmd.model,
            [GenAi.ResponseModel]: cmd.model,
            "gen_ai.provider": cmd.provider,
            "gen_ai.api": cmd.api,
            [Goodboy.TaskId]: taskId,
          },
          startTime: cmd.startedAtMs,
        }, stageCtx);
        chatSpans.set(cmd.key, span);
        return;
      }
      case "chat.end": {
        const span = chatSpans.get(cmd.key);
        if (!span) return;
        span.setAttributes({
          [GenAi.UsageInputTokens]: cmd.usage.inputTokens,
          [GenAi.UsageOutputTokens]: cmd.usage.outputTokens,
          [GenAi.UsageCacheReadTokens]: cmd.usage.cacheReadTokens,
          [GenAi.UsageCacheWriteTokens]: cmd.usage.cacheWriteTokens,
          [Goodboy.CostUsd]: cmd.usage.costUsd,
          [Goodboy.StopReason]: cmd.stopReason,
          [GenAi.ResponseFinishReasons]: [cmd.stopReason],
        });
        span.addEvent("assistant.text", { text: cmd.textPreview });
        if (cmd.thinkingPreview) span.addEvent("assistant.thinking", { text: cmd.thinkingPreview });
        if (cmd.errorMessage) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(cmd.errorMessage, 512) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end(cmd.endedAtMs);
        chatSpans.delete(cmd.key);
        return;
      }
      case "tool.start": {
        const parent = chatSpans.get(cmd.parentChatKey) ?? stageSpan;
        const parentCtx = trace.setSpan(context.active(), parent);
        const span = tracer.startSpan(`execute_tool ${cmd.name}`, {
          attributes: {
            [GenAi.OperationName]: "execute_tool",
            [GenAi.ToolName]: cmd.name,
            [GenAi.ToolCallId]: cmd.key,
            [Goodboy.ToolArgs]: cmd.argsJson,
          },
          startTime: cmd.startedAtMs,
        }, parentCtx);
        toolSpans.set(cmd.key, span);
        return;
      }
      case "tool.end": {
        const span = toolSpans.get(cmd.key);
        if (!span) return;
        span.setAttributes({
          [Goodboy.ToolOutput]: cmd.outputPreview,
          [Goodboy.ToolIsError]: cmd.isError,
        });
        if (cmd.isError) span.setStatus({ code: SpanStatusCode.ERROR });
        else span.setStatus({ code: SpanStatusCode.OK });
        span.end(cmd.endedAtMs);
        toolSpans.delete(cmd.key);
        return;
      }
      case "stage.event": {
        stageSpan.addEvent(cmd.name, cmd.attributes);
        return;
      }
      case "cost.add": {
        totalCost += cmd.usd;
        stageSpan.setAttribute(Goodboy.CostUsd, Number(totalCost.toFixed(6)));
        return;
      }
    }
  }

  const stopWatcher = watchSessionFile(sessionPath, (entry) => {
    try {
      const out = translate(state, entry);
      state = out.state;
      for (const cmd of out.commands) handle(cmd);
    } catch (err) {
      log.warn(`Bridge error on entry: ${String(err)}`);
    }
  });

  return () => {
    stopWatcher();
    // Force-close any spans the bridge didn't see an end for (e.g. killed session).
    const now = Date.now();
    for (const span of toolSpans.values()) { span.setStatus({ code: SpanStatusCode.ERROR, message: "session killed" }); span.end(now); }
    for (const span of chatSpans.values()) { span.setStatus({ code: SpanStatusCode.ERROR, message: "session killed" }); span.end(now); }
    toolSpans.clear();
    chatSpans.clear();
  };
}
```

**Verify:**
Build passes. Nothing wires it in yet.

**Commit:** `feat(observability): IO bridge translating pi sessions to live OTel spans`

---

### Task 9: Wire the bridge into runStage and PR session

**Files:**
- Modify: `src/core/stage.ts`
- Modify: `src/pipelines/pr-session/session.ts`

**Implementation:**

In `runStage`, inside the `withStageSpan` callback from Task 5, start the bridge right after `broadcastSessionFile` and stop it in the existing `finally`:

```ts
const stopBroadcast = broadcastSessionFile(sessionPath, { scope: "task", taskId, stage });
const stopBridge = bridgeSessionToOtel({ sessionPath, stageSpan, taskId });
// ...
} finally {
  session.kill();
  await session.waitForExit();
  clearActiveSession(taskId);
  stopBridge();
  stopBroadcast();
}
```

In `src/pipelines/pr-session/session.ts`, each entry point spawns a pi session directly (not through `runStage`). For each, after `broadcastSessionFile(...)`, call `bridgeSessionToOtel({ sessionPath, stageSpan: /* current active span */, taskId: prSessionRunId })`. Use `trace.getActiveSpan()!` since we're inside `withPipelineSpan` from Task 6.

**Verify:**
Run a full coding task end to end on an EC2 branch (dev instance). Open Logfire, find the trace, confirm:
- Root: `goodboy.pipeline.coding`
- 3 children: `goodboy.stage.planner/implementer/reviewer`
- Under each: multiple `gen_ai.chat <model>` spans with non-zero `gen_ai.usage.*`
- Under each chat: `execute_tool <name>` spans for every tool call
- Summed `goodboy.cost_usd` on each stage span roughly matches `pi` cost output
- Thinking / bash events show up inline

**Commit:** `feat(observability): attach JSONL -> OTel bridge to every pi session`

---

### Task 10: Module README

**Files:**
- Create: `src/observability/README.md`

**Implementation:**

One-page doc covering: module purpose, file map, env vars, how to enable/disable, how to look up a trace from a task id (Logfire query `goodboy.task_id = '…'`), how to swap Logfire for another OTel backend (replace `logfire.configure` call in `logfire.ts`, everything else stays). Include a mermaid diagram of the span tree for a coding task.

**Verify:**
Read it back, make sure someone unfamiliar with the repo could enable observability in under 5 minutes.

**Commit:** `docs(observability): module README`

---

### Task 11: EC2 deployment wiring

**Files:**
- Modify: `deploy.sh` (only if it currently rewrites `.env` on deploy; otherwise no change)
- Update the EC2 `.env` directly on the host (not committed): add `LOGFIRE_TOKEN=...` and `LOGFIRE_ENVIRONMENT=prod`.
- Verify the goodboy systemd unit does `ExecStop=/bin/kill -SIGTERM $MAINPID` with `TimeoutStopSec >= 10s` so shutdownObservability has time to flush. If not, update the unit file on the host.

**Implementation:**

```
ssh goodboy
sudo systemctl cat goodboy.service   # inspect
# If TimeoutStopSec is missing or < 10:
sudo systemctl edit goodboy.service
# Add:
# [Service]
# TimeoutStopSec=15s
sudo systemctl daemon-reload
# Then edit the env file used by the unit (usually ~/goodboy/.env) and add the LOGFIRE_* vars.
./deploy-goodboy.sh
```

**Verify:**
After deploy, trigger a task from the real Telegram. Confirm trace appears in Logfire within ~10s of stage completion. Run `sudo systemctl restart goodboy` mid-task and confirm the in-progress spans still show up in Logfire (not dropped) — this is the flush-on-shutdown test.

**Commit:** no commit (host-only change for env + systemd).

---

### Task 12: End-to-end verification matrix

**Implementation:**

Run one of each, confirm trace shape in Logfire for each:

| Scenario | Expected root span | Expected notable children |
|---|---|---|
| Coding task (happy path) | `goodboy.pipeline.coding` | planner + implementer + reviewer stages, each with chat + tool spans |
| Coding task (forced failure in implementer) | `goodboy.pipeline.coding` with ERROR status | implementer stage ERROR; planner/reviewer absent |
| Question task | `goodboy.pipeline.question` | single `question` stage |
| PR review (drive-by) | `goodboy.pipeline.pr-review` | review stage with tool spans |
| PR session creation round | `goodboy.pipeline.pr-session` | `pr_creator` stage + `goodboy.pr_session.id` attribute |
| PR session revision round | `goodboy.pipeline.pr-session` | `revision` stage, different trace from creation round, linked by `goodboy.pr_session.id` |
| Task cancellation via dashboard | stage span ERROR with message `Session killed` | any in-flight tool/chat spans force-closed with ERROR |

If any row fails, file a fix-up task before closing this plan out.

**Commit:** (verification only; no code.)

---

## What this plan intentionally does not do

- **Metrics.** OTel metrics (counters, histograms) are powerful but Logfire can already derive everything we need from span attributes (cost per repo, p95 stage latency, tool error rate). Add later if dashboards demand it.
- **Log correlation.** `createLogger` stays text-only. Bridging Node logs into OTel logs is a separate project and pi already has its own persistent log (the JSONL).
- **Auto-instrumentation.** We don't enable `getNodeAutoInstrumentations()`. HTTP/fs noise would drown the agent traces. Can be added behind a flag if we ever want to debug Hono / pg latency.
- **Prompt text on attributes.** Content goes on events only. Keeps span attribute indexes small and cheap; avoids accidentally indexing 50 KB prompts.
- **Sampling.** Everything is sampled at 100% for now. Logfire's free tier is generous and agent runs are low-frequency. Revisit if we hit quota.

---

## Rollback

Unset `LOGFIRE_TOKEN` in the EC2 env and restart the service — `sendToLogfire: "if-token-present"` turns the SDK into a no-op and no spans leave the process. Full rollback = revert the commits from tasks 4-9 (init + wrapping calls); the `src/observability/` directory alone is inert.

---

Plan ready. Want me to start executing now, or do you want to review first?
