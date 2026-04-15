import type { StageName, TaskKind } from "./types.js";

export interface TaskKindConfig {
  readonly label: string;
  readonly stages: readonly StageName[];
  readonly artifacts: readonly { key: string; label: string }[];
}

export const TASK_KIND_CONFIG: Record<TaskKind, TaskKindConfig> = {
  coding_task: {
    label: "coding task",
    stages: ["planner", "implementer", "reviewer"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};
