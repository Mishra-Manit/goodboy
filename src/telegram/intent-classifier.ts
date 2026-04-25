/**
 * LLM-backed intent classifier for inbound Telegram messages. Emits a
 * discriminated `Intent` union validated by Zod; any failure (LLM error,
 * schema mismatch) falls back to `{ type: "unknown", rawText }`.
 */

import { z } from "zod";
import { LIGHT_MODEL, structuredOutput } from "../shared/llm.js";
import { createLogger } from "../shared/logger.js";
import { buildClassifierSystemPrompt, type ClassifierRepoContext } from "./prompts.js";

const log = createLogger("intent-classifier");

const LOG_PREVIEW_LEN = 500;

// --- Schemas ---

const intentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("coding_task"),       repo: z.string(), description: z.string() }),
  z.object({ type: z.literal("pr_review"),         repo: z.string(), prIdentifier: z.string() }),
  z.object({ type: z.literal("codebase_question"), repo: z.string(), question: z.string() }),
  z.object({ type: z.literal("task_status"),       taskPrefix: z.string().optional() }),
  z.object({ type: z.literal("task_cancel"),       taskPrefix: z.string() }),
  z.object({ type: z.literal("task_retry"),        taskPrefix: z.string() }),
  z.object({ type: z.literal("unknown"),           rawText: z.string() }),
]);

export type Intent = z.infer<typeof intentSchema>;

type ClassifierRepoInput = string | ClassifierRepoContext;

// --- Public API ---

/** Classify a user message with the default light model. Never throws; falls back to `unknown` on failure. */
export async function classifyMessage(text: string, repos: readonly ClassifierRepoInput[]): Promise<Intent> {
  return classifyMessageWithModel(text, repos, LIGHT_MODEL);
}

/** Classify a user message with an explicit model override for manual benchmarking. */
export async function classifyMessageWithModel(
  text: string,
  repos: readonly ClassifierRepoInput[],
  model: string,
): Promise<Intent> {
  try {
    const intent = await structuredOutput({
      system: buildClassifierSystemPrompt(normalizeRepoContexts(repos)),
      prompt: text,
      schema: intentSchema,
      model,
      temperature: 0,
    });
    log.info(`Classified message as "${intent.type}"`, {
      type: intent.type,
      model,
      preview: text.slice(0, LOG_PREVIEW_LEN),
    });
    return intent;
  } catch (err) {
    log.error("Classification failed, returning unknown", err);
    return { type: "unknown", rawText: text };
  }
}

function normalizeRepoContexts(repos: readonly ClassifierRepoInput[]): ClassifierRepoContext[] {
  return repos.map((repo) => (typeof repo === "string" ? { name: repo } : repo));
}
