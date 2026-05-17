/**
 * Static metadata for each task kind: display label, ordered stages, and the
 * artifact files it produces. Consumed by the dashboard and any code that
 * needs to reason about "what does a <kind> task look like?".
 */

import { PR_IMPACT_VARIANT_COUNT, prImpactVariantFiles } from "./pr-impact-variants.js";
import type { StageName, TaskKind } from "./types.js";

export interface TaskKindConfig {
  readonly label: string;
  readonly stages: readonly StageName[];
  readonly artifacts: readonly { key: string; label: string }[];
}

export const TASK_KIND_CONFIG: Record<TaskKind, TaskKindConfig> = {
  coding_task: {
    label: "coding task",
    stages: ["memory", "planner", "implementer", "reviewer", "pr_creator"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["memory", "answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["memory", "pr_impact", "pr_analyst", "pr_finalizer"],
    artifacts: [
      ...Array.from({ length: PR_IMPACT_VARIANT_COUNT }, (_, index) => {
        const variant = index + 1;
        return { key: prImpactVariantFiles(variant).impact, label: `impact v${variant}` };
      }),
      { key: "pr-changes-summary.md", label: "PR changes summary" },
      { key: "final-comment.md", label: "posted comment" },
      { key: "review.json", label: "finalized review" },
    ],
  },
};
