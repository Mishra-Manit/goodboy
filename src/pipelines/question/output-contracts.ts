/** Output contract for the codebase-question pipeline. */

import { defineTextOutput } from "../../shared/agent-output/contracts.js";

export const questionOutputs = {
  answer: defineTextOutput({
    id: "question.answer",
    path: () => "answer.md",
    prompt: { name: "codebase answer", instructions: "Write the user-facing answer here as plain text." },
    dashboard: () => ({ key: "answer.md", label: "answer" }),
  }),
};
