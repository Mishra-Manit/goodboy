import { z } from "zod";
import { structuredOutput } from "../shared/llm.js";
import { createLogger } from "../shared/logger.js";
import { buildClassifierSystemPrompt } from "./prompts.js";

const log = createLogger("intent-classifier");

const codingTaskIntent = z.object({
  type: z.literal("coding_task"),
  repo: z.string(),
  description: z.string(),
});

const prReviewIntent = z.object({
  type: z.literal("pr_review"),
  repo: z.string(),
  prIdentifier: z.string(),
});

const codebaseQuestionIntent = z.object({
  type: z.literal("codebase_question"),
  repo: z.string(),
  question: z.string(),
});

const taskStatusIntent = z.object({
  type: z.literal("task_status"),
  taskPrefix: z.string().optional(),
});

const taskCancelIntent = z.object({
  type: z.literal("task_cancel"),
  taskPrefix: z.string(),
});

const taskRetryIntent = z.object({
  type: z.literal("task_retry"),
  taskPrefix: z.string(),
});

const unknownIntent = z.object({
  type: z.literal("unknown"),
  rawText: z.string(),
});

const intentSchema = z.discriminatedUnion("type", [
  codingTaskIntent,
  prReviewIntent,
  codebaseQuestionIntent,
  taskStatusIntent,
  taskCancelIntent,
  taskRetryIntent,
  unknownIntent,
]);

export type Intent = z.infer<typeof intentSchema>;

export async function classifyMessage(
  text: string,
  repoNames: readonly string[],
): Promise<Intent> {
  try {
    const intent = await structuredOutput({
      system: buildClassifierSystemPrompt(repoNames),
      prompt: text,
      schema: intentSchema,
      temperature: 0,
    });

    log.info(`Classified message as "${intent.type}"`, {
      type: intent.type,
      preview: text.slice(0, 80),
    });

    return intent;
  } catch (err) {
    log.error("Classification failed, returning unknown", err);
    return { type: "unknown", rawText: text };
  }
}
