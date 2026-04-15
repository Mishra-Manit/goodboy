import { z } from "zod";
import { structuredOutput } from "./llm.js";
import { createLogger } from "./logger.js";

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

const planConfirmIntent = z.object({
  type: z.literal("plan_confirm"),
});

const planReplyIntent = z.object({
  type: z.literal("plan_reply"),
  reply: z.string(),
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
  planConfirmIntent,
  planReplyIntent,
  unknownIntent,
]);

export type Intent = z.infer<typeof intentSchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  repoNames: readonly string[],
  hasActiveConversation: boolean,
): string {
  const repoList = repoNames.length > 0
    ? repoNames.map((r) => `  - ${r}`).join("\n")
    : "  (none registered)";

  const conversationContext = hasActiveConversation
    ? `The user is currently in an active conversation with a planner agent that may be waiting for input.
If the message is a direct answer, clarification, or confirmation for the planner, classify as "plan_reply" or "plan_confirm".
Only classify as something else if the message is clearly a new task, command, or question unrelated to the ongoing conversation.`
    : `There is no active conversation. Do not classify as "plan_reply" or "plan_confirm".`;

  return `You are a message intent classifier for a coding agent system. Analyze the user's message and classify it into exactly one intent.

Available repositories:
${repoList}

${conversationContext}

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

7. "plan_confirm" -- The user is confirming a plan and wants to proceed. Messages like "go", "do it", "ship it", "yes", "proceed", "looks good".

8. "plan_reply" -- The user is answering a question from the planner. The reply field should contain the full message text.

9. "unknown" -- The message does not fit any of the above categories.

Rules:
- The repo name MUST exactly match one of the available repos listed above. If the user references a repo that is not in the list, classify as "unknown".
- For "coding_task", do not include the repo name in the description -- separate them cleanly.
- For task IDs, extract whatever ID fragment the user provides (e.g. "a1b2c3d4").
- When in doubt between "plan_reply" and a new task, prefer "plan_reply" if there is an active conversation.
- Respond with a single JSON object. No extra text, no markdown, no explanation.

The JSON object MUST have a "type" field as the FIRST key. Exact schemas:

{"type": "coding_task", "repo": "<repo_name>", "description": "<task description>"}
{"type": "pr_review", "repo": "<repo_name>", "prIdentifier": "<PR number or URL>"}
{"type": "codebase_question", "repo": "<repo_name>", "question": "<the question>"}
{"type": "task_status"} or {"type": "task_status", "taskPrefix": "<id prefix>"}
{"type": "task_cancel", "taskPrefix": "<id prefix>"}
{"type": "task_retry", "taskPrefix": "<id prefix>"}
{"type": "plan_confirm"}
{"type": "plan_reply", "reply": "<full message text>"}
{"type": "unknown", "rawText": "<original message>"}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyMessage(
  text: string,
  repoNames: readonly string[],
  hasActiveConversation: boolean,
): Promise<Intent> {
  try {
    const intent = await structuredOutput({
      system: buildSystemPrompt(repoNames, hasActiveConversation),
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
