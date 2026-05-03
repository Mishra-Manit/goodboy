/**
 * Canonical artifact names and path builders for the PR review pipeline.
 * Keeps stage-to-stage contracts in one place instead of scattering literals.
 */

import path from "node:path";
import { artifactPath } from "../../../shared/artifacts/index.js";
import {
  PR_IMPACT_VARIANT_COUNT,
  prImpactVariantFiles,
  type PrImpactVariantFiles,
} from "../../../shared/domain/pr-impact-variants.js";

export { PR_IMPACT_VARIANT_COUNT, prImpactVariantFiles, type PrImpactVariantFiles };

export const PR_REVIEW_FILES = {
  context: "pr-context.json",
  diff: "pr.diff",
  updatedContext: "pr-context.updated.json",
  updatedDiff: "pr.updated.diff",
  reviewPlan: "review-plan.json",
  reviewerFeedback: "code-reviewer-feedback.md",
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
  reviewPlan: string;
  reviewerFeedback: string;
  summary: string;
  review: string;
  reportsDir: string;
}

export interface PrImpactVariantPaths {
  variant: number;
  diff: string;
  impact: string;
}

/** Resolve every canonical PR-review artifact path from the task artifacts dir. */
export function prReviewArtifactPaths(artifactsDir: string): PrReviewArtifactPaths {
  return {
    context: artifactPath(artifactsDir, PR_REVIEW_FILES.context),
    diff: artifactPath(artifactsDir, PR_REVIEW_FILES.diff),
    updatedContext: artifactPath(artifactsDir, PR_REVIEW_FILES.updatedContext),
    updatedDiff: artifactPath(artifactsDir, PR_REVIEW_FILES.updatedDiff),
    reviewPlan: artifactPath(artifactsDir, PR_REVIEW_FILES.reviewPlan),
    reviewerFeedback: artifactPath(artifactsDir, PR_REVIEW_FILES.reviewerFeedback),
    summary: artifactPath(artifactsDir, PR_REVIEW_FILES.summary),
    review: artifactPath(artifactsDir, PR_REVIEW_FILES.review),
    reportsDir: path.join(artifactsDir, PR_REVIEW_DIRS.reports),
  };
}

/** Path to one subagent report under `reports/`. */
export function prReviewReportPath(artifactsDir: string, reportId: string): string {
  return path.join(prReviewArtifactPaths(artifactsDir).reportsDir, `${reportId}.json`);
}

/** Absolute root-level paths for one impact variant. */
export function prImpactVariantPaths(artifactsDir: string, variant: number): PrImpactVariantPaths {
  const files = prImpactVariantFiles(variant);
  return {
    variant,
    diff: artifactPath(artifactsDir, files.diff),
    impact: artifactPath(artifactsDir, files.impact),
  };
}

/** All configured impact variant paths in stable order. */
export function allPrImpactVariantPaths(artifactsDir: string): PrImpactVariantPaths[] {
  return Array.from({ length: PR_IMPACT_VARIANT_COUNT }, (_, index) => (
    prImpactVariantPaths(artifactsDir, index + 1)
  ));
}
