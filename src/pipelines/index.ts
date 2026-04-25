/**
 * Canonical backend task-kind → pipeline registry. API and Telegram both use
 * this map so adding a new task kind only requires one registration change.
 */

import { runPipeline } from "./coding/pipeline.js";
import { runQuestion } from "./question/pipeline.js";
import { runPrReview } from "./pr-review/pipeline.js";
import type { SendTelegram } from "../core/stage.js";
import type { TaskKind } from "../shared/types.js";

// --- Public API ---

export type PipelineRunner = (taskId: string, send: SendTelegram) => Promise<void>;

/** All task pipelines keyed by `TaskKind`. */
export const PIPELINES: Record<TaskKind, PipelineRunner> = {
  coding_task: runPipeline,
  codebase_question: runQuestion,
  pr_review: runPrReview,
};
