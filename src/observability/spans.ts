/**
 * High-level span helpers. Every pipeline calls `withPipelineSpan` at its
 * top and `core/stage.ts` calls `withStageSpan` for each stage. Both are
 * thin wrappers around `tracer.startActiveSpan` that (a) pre-populate the
 * goodboy attribute set, (b) set span status from the callback's outcome,
 * (c) always end the span.
 */

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  type Span,
  type TimeInput,
} from "@opentelemetry/api";
import { getTracer } from "./tracer.js";
import { GenAi, Goodboy } from "./attributes.js";
import type { StageName } from "../shared/types.js";

// --- Pipeline span ---

/** Named kinds for the pipeline span suffix. Not tied to `TaskKind` -- PR
 * sessions have no task row and still emit pipeline spans. */
export type PipelineKind =
  | "coding_task"
  | "codebase_question"
  | "pr_review"
  | "pr_session"
  | "memory";

export interface PipelineSpanContext {
  taskId: string;
  kind: PipelineKind;
  repo?: string;
  branch?: string;
  /** Override the span start time (replay scripts only; production leaves it unset). */
  startTime?: TimeInput;
}

/**
 * Wrap the body of a pipeline entry point in a root OTel span.
 *
 * Pipelines are always root traces: a pr_session turn triggered from inside
 * a coding_task must not inherit coding_task as its parent. We explicitly
 * run `startActiveSpan` under `ROOT_CONTEXT` so the new span has no parent
 * regardless of the ambient context at the call site.
 */
export async function withPipelineSpan<T>(
  ctx: PipelineSpanContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return context.with(ROOT_CONTEXT, () =>
    getTracer().startActiveSpan(
      `goodboy.pipeline.${ctx.kind}`,
      {
        attributes: {
          [Goodboy.TaskId]: ctx.taskId,
          [Goodboy.PipelineKind]: ctx.kind,
          ...(ctx.repo ? { [Goodboy.Repo]: ctx.repo } : {}),
          ...(ctx.branch ? { [Goodboy.Branch]: ctx.branch } : {}),
          [GenAi.ConversationId]: ctx.taskId,
        },
        ...(ctx.startTime !== undefined ? { startTime: ctx.startTime } : {}),
      },
      async (span) => {
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
      },
    ),
  );
}

// --- Stage span ---

export interface StageSpanContext {
  taskId: string;
  stage: StageName;
  model: string;
  stageLabel: string;
  piSessionPath: string;
  /** Override the span start time (replay scripts only; production leaves it unset). */
  startTime?: TimeInput;
}

/** Wrap a single pi stage run in a child OTel span; parents the JSONL bridge's spans. */
export async function withStageSpan<T>(
  ctx: StageSpanContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    `goodboy.stage.${ctx.stage}`,
    {
      attributes: {
        [Goodboy.TaskId]: ctx.taskId,
        [Goodboy.Stage]: ctx.stage,
        [Goodboy.PiSessionPath]: ctx.piSessionPath,
        [GenAi.AgentName]: ctx.stageLabel,
        [GenAi.RequestModel]: ctx.model,
        [GenAi.System]: "pi",
      },
      ...(ctx.startTime !== undefined ? { startTime: ctx.startTime } : {}),
    },
    async (span) => {
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
    },
  );
}
