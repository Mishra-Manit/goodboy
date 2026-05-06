/**
 * Output contracts and path helpers for the PR review pipeline.
 * This is the single source for PR-review artifact names, schemas, and dashboard metadata.
 */

import { defineJsonOutput, defineTextOutput } from "../../shared/agent-output/contracts.js";
import { prReviewArtifactSchema } from "../../shared/contracts/pr-review.js";
import { PR_IMPACT_VARIANT_COUNT, prImpactVariantFiles } from "../../shared/domain/pr-impact-variants.js";
import { prReviewPlanSchema, prReviewReportSchema } from "../../shared/domain/types.js";

export { PR_IMPACT_VARIANT_COUNT, prImpactVariantFiles };

export const PR_REVIEW_REPORTS_DIR = "reports";
export const HOLISTIC_REPORT_ID = "holistic";

// The complete list of valid dimension values. These are the ONLY strings
// accepted by the schema. Any other value (e.g. "reliability", "docs",
// "performance") will fail Zod validation and fail the task.
const DIMENSIONS_LEGEND = `\
VALID dimensions values — use ONLY these exact strings, nothing else:
  "correctness"  logic bugs, runtime errors, incorrect behaviour
  "style"        formatting, naming, readability
  "tests"        test coverage, test correctness
  "security"     auth, injection, secrets, data exposure
Do NOT invent values like "reliability", "docs", "performance", or "maintainability".`;

export const prReviewOutputs = {
  context: defineTextOutput({
    id: "prReview.context",
    path: () => "pr-context.json",
    prompt: { name: "PR metadata" },
  }),
  diff: defineTextOutput({
    id: "prReview.diff",
    path: () => "pr.diff",
    prompt: { name: "PR diff" },
  }),
  updatedContext: defineTextOutput({
    id: "prReview.updatedContext",
    path: () => "pr-context.updated.json",
    prompt: { name: "updated PR metadata" },
  }),
  updatedDiff: defineTextOutput({
    id: "prReview.updatedDiff",
    path: () => "pr.updated.diff",
    prompt: { name: "updated PR diff" },
  }),
  reviewerFeedback: defineTextOutput({
    id: "prReview.reviewerFeedback",
    path: () => "code-reviewer-feedback.md",
    prompt: { name: "code reviewer feedback" },
  }),
  summary: defineTextOutput({
    id: "prReview.summary",
    path: () => "summary.md",
    prompt: { name: "GitHub review summary", instructions: "Write the posted GitHub review summary here." },
    dashboard: () => ({ key: "summary.md", label: "summary" }),
  }),
  reviewPlan: defineJsonOutput({
    id: "prReview.reviewPlan",
    path: () => "review-plan.json",
    schema: prReviewPlanSchema,
    prompt: {
      name: "PR review fanout plan",
      instructions: `Write the analyst fanout plan here as strict JSON.\n\n${DIMENSIONS_LEGEND}`,
      skeleton: `{
  "groups": [
    {
      "id": "group-01",
      "files": ["src/example.ts"],
      "dimensions": ["correctness", "style"],
      "focus": "what this group should verify"
    },
    {
      "id": "group-02",
      "files": ["src/example.test.ts"],
      "dimensions": ["tests"],
      "focus": "what this group should verify"
    }
  ],
  "skipped": ["package-lock.json"],
  "focus_notes": "short overall review focus"
}`,
    },
  }),
  report: defineJsonOutput({
    id: "prReview.report",
    path: ({ reportId }: { reportId: string }) => `${PR_REVIEW_REPORTS_DIR}/${reportId}.json`,
    schema: prReviewReportSchema,
    prompt: {
      name: "PR slice report",
      instructions: `Parent analyst writes one validated report JSON for this report id after reading subagent final JSON.\n\n${DIMENSIONS_LEGEND}`,
      skeleton: `{
  "subagent_id": "group-01",
  "files_reviewed": [],
  "dimensions": ["correctness"],
  "issues": [],
  "notes": ""
}`,
    },
  }),
  impact: defineTextOutput({
    id: "prReview.impact",
    path: ({ variant }: { variant: number }) => prImpactVariantFiles(variant).impact,
    prompt: { name: "PR impact report", instructions: "Write the curated impact analysis here." },
  }),
  impactDiff: defineTextOutput({
    id: "prReview.impactDiff",
    path: ({ variant }: { variant: number }) => prImpactVariantFiles(variant).diff,
    prompt: { name: "PR impact diff variant" },
  }),
  review: defineJsonOutput({
    id: "prReview.dashboardReview",
    path: () => "review.json",
    schema: prReviewArtifactSchema,
    prompt: {
      name: "dashboard review model",
      instructions: "Write the strict dashboard review model here.",
      skeleton: `{
  "prTitle": "PR title",
  "headSha": "1234567",
  "summary": "One tight paragraph.",
  "chapters": [
    {
      "id": "chapter",
      "title": "Chapter",
      "narrative": "What this group of changes achieves.",
      "files": [
        {
          "path": "src/example.ts",
          "narrative": "What changed in this file and why it matters."
        }
      ],
      "annotations": []
    }
  ]
}`,
    },
    dashboard: () => ({ key: "review.json", label: "display model" }),
  }),
};

export function prReviewReportsDir(artifactsDir: string): string {
  return `${artifactsDir.replace(/\/+$/, "")}/${PR_REVIEW_REPORTS_DIR}`;
}

export function prImpactVariantPaths(artifactsDir: string, variant: number): { variant: number; diff: string; impact: string } {
  return {
    variant,
    diff: prReviewOutputs.impactDiff.resolve(artifactsDir, { variant }).path,
    impact: prReviewOutputs.impact.resolve(artifactsDir, { variant }).path,
  };
}

export function allPrImpactVariantPaths(artifactsDir: string): Array<{ variant: number; diff: string; impact: string }> {
  return Array.from({ length: PR_IMPACT_VARIANT_COUNT }, (_, index) => prImpactVariantPaths(artifactsDir, index + 1));
}
