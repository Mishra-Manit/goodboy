import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PR_IMPACT_VARIANT_COUNT,
  PR_REVIEW_DIRS,
  PR_REVIEW_FILES,
  allPrImpactVariantPaths,
  prImpactVariantFiles,
  prImpactVariantPaths,
  prReviewArtifactPaths,
  prReviewReportPath,
} from "@src/pipelines/pr-review/artifacts.js";

describe("prReviewArtifactPaths", () => {
  it("builds the canonical artifact paths from one artifacts dir", () => {
    const base = "/tmp/task-123";
    const paths = prReviewArtifactPaths(base);

    expect(paths.context).toBe(path.join(base, PR_REVIEW_FILES.context));
    expect(paths.diff).toBe(path.join(base, PR_REVIEW_FILES.diff));
    expect(paths.updatedContext).toBe(path.join(base, PR_REVIEW_FILES.updatedContext));
    expect(paths.updatedDiff).toBe(path.join(base, PR_REVIEW_FILES.updatedDiff));
    expect(paths.reviewPlan).toBe(path.join(base, PR_REVIEW_FILES.reviewPlan));
    expect(paths.summary).toBe(path.join(base, PR_REVIEW_FILES.summary));
    expect(paths.review).toBe(path.join(base, PR_REVIEW_FILES.review));
    expect(paths.reportsDir).toBe(path.join(base, PR_REVIEW_DIRS.reports));
  });

  it("builds report paths under the reports directory", () => {
    expect(prReviewReportPath("/tmp/task-123", "group-01")).toBe(
      path.join("/tmp/task-123", PR_REVIEW_DIRS.reports, "group-01.json"),
    );
  });

  it("builds root-level impact variant artifact paths", () => {
    expect(PR_IMPACT_VARIANT_COUNT).toBe(3);
    expect(prImpactVariantFiles(2)).toEqual({ diff: "pr.diff.v2", impact: "pr-impact.v2.md" });
    expect(prImpactVariantPaths("/tmp/task-123", 2)).toEqual({
      variant: 2,
      diff: path.join("/tmp/task-123", "pr.diff.v2"),
      impact: path.join("/tmp/task-123", "pr-impact.v2.md"),
    });
    expect(allPrImpactVariantPaths("/tmp/task-123").map((paths) => paths.variant)).toEqual([1, 2, 3]);
  });

});
