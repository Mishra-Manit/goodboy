/**
 * Canonical artifact names and path builders for the PR review pipeline.
 * Keeps stage-to-stage contracts in one place instead of scattering literals.
 */

import path from "node:path";
import { artifactPath } from "../../shared/artifacts.js";

export const PR_REVIEW_FILES = {
  context: "pr-context.json",
  diff: "pr.diff",
  updatedContext: "pr-context.updated.json",
  updatedDiff: "pr.updated.diff",
  impact: "pr-impact.md",
  reviewPlan: "review-plan.json",
  summary: "summary.md",
  review: "review.json",
} as const;

export const PR_REVIEW_DIRS = {
  reports: "reports",
} as const;

export interface PrReviewArtifactPaths {
  context: string;
  diff: string;
  updatedContext: string;
  updatedDiff: string;
  impact: string;
  reviewPlan: string;
  summary: string;
  review: string;
  reportsDir: string;
}

/** Resolve every canonical PR-review artifact path from the task artifacts dir. */
export function prReviewArtifactPaths(artifactsDir: string): PrReviewArtifactPaths {
  return {
    context: artifactPath(artifactsDir, PR_REVIEW_FILES.context),
    diff: artifactPath(artifactsDir, PR_REVIEW_FILES.diff),
    updatedContext: artifactPath(artifactsDir, PR_REVIEW_FILES.updatedContext),
    updatedDiff: artifactPath(artifactsDir, PR_REVIEW_FILES.updatedDiff),
    impact: artifactPath(artifactsDir, PR_REVIEW_FILES.impact),
    reviewPlan: artifactPath(artifactsDir, PR_REVIEW_FILES.reviewPlan),
    summary: artifactPath(artifactsDir, PR_REVIEW_FILES.summary),
    review: artifactPath(artifactsDir, PR_REVIEW_FILES.review),
    reportsDir: path.join(artifactsDir, PR_REVIEW_DIRS.reports),
  };
}

/** Path to one subagent report under `reports/`. */
export function prReviewReportPath(artifactsDir: string, reportId: string): string {
  return path.join(prReviewArtifactPaths(artifactsDir).reportsDir, `${reportId}.json`);
}
