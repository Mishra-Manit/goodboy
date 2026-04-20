import { z } from "zod";
import { structuredOutput } from "../shared/llm.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("classifier");

// ---------------------------------------------------------------------------
// Intent schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(repoNames: readonly string[]): string {
  const repoList = repoNames.length > 0
    ? repoNames.map((r) => `  - ${r}`).join("\n")
    : "  (none registered)";

  return `You are a message intent classifier for a coding agent system. Analyze the user's message and classify it into exactly one intent.

Available repositories:
${repoList}

Intent types:

1. "coding_task" -- The user wants code written, a feature added, a bug fixed, or any implementation work.
   Extract the repo name (must match one of the available repos) and a clean description of the task.

2. "pr_review" -- The user wants a pull request reviewed.
   Extract the repo name and the PR identifier (number or URL).

3. "codebase_question" -- The user is asking a question about how the codebase works, not requesting changes.
   Extract the repo name and the question.

4. "task_status" -- The user is asking about the status of running or recent tasks.
   Optionally extract a task ID prefix if they reference a specific task.

5. "task_cancel" -- The user wants to cancel a running task.
   Extract the task ID prefix.

6. "task_retry" -- The user wants to retry a failed task.
   Extract the task ID prefix.

7. "unknown" -- The message does not fit any of the above categories.

Rules:
- The repo name MUST exactly match one of the available repos listed above. If the user references a repo that is not in the list, classify as "unknown".
- For "coding_task", do not include the repo name in the description -- separate them cleanly.
- For task IDs, extract whatever ID fragment the user provides (e.g. "a1b2c3d4").
- Respond with a single JSON object. No extra text, no markdown, no explanation.

The JSON object MUST have a "type" field as the FIRST key. Exact schemas:

{"type": "coding_task", "repo": "<repo_name>", "description": "<task description>"}
{"type": "pr_review", "repo": "<repo_name>", "prIdentifier": "<PR number or URL>"}
{"type": "codebase_question", "repo": "<repo_name>", "question": "<the question>"}
{"type": "task_status"} or {"type": "task_status", "taskPrefix": "<id prefix>"}
{"type": "task_cancel", "taskPrefix": "<id prefix>"}
{"type": "task_retry", "taskPrefix": "<id prefix>"}
{"type": "unknown", "rawText": "<original message>"}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyMessage(
  text: string,
  repoNames: readonly string[],
): Promise<Intent> {
  try {
    const intent = await structuredOutput({
      system: buildSystemPrompt(repoNames),
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
