import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInsideArtifacts,
  PR_REVIEW_ASSETS_DIR,
  PR_VISUAL_SUMMARY_FILENAME,
  publicReviewAssetUrl,
  reviewAssetPath,
  reviewAssetsDir,
} from "@src/pipelines/pr-review/assets.js";
import { config, resetEnvForTesting } from "@src/shared/runtime/config.js";

describe("PR review asset helpers", () => {
  it("builds asset paths under the task artifact directory", () => {
    const taskId = "11111111-1111-1111-1111-111111111111";

    expect(reviewAssetsDir(taskId)).toBe(path.join(config.artifactsDir, taskId, PR_REVIEW_ASSETS_DIR));
    expect(reviewAssetPath(taskId, PR_VISUAL_SUMMARY_FILENAME)).toBe(
      path.join(config.artifactsDir, taskId, PR_REVIEW_ASSETS_DIR, PR_VISUAL_SUMMARY_FILENAME),
    );
    expect(reviewAssetPath(taskId, "../bad.png")).toBeNull();
  });

  it("builds public URLs from the configured base", () => {
    process.env.PUBLIC_ASSET_BASE_URL = "https://goodboy.test/";
    resetEnvForTesting();

    expect(publicReviewAssetUrl("task-1", PR_VISUAL_SUMMARY_FILENAME)).toBe(
      "https://goodboy.test/review-assets/task-1/pr-visual-summary.png",
    );

    delete process.env.PUBLIC_ASSET_BASE_URL;
    resetEnvForTesting();
  });

  it("guards paths outside the artifacts root", () => {
    expect(isInsideArtifacts(path.join(config.artifactsDir, "task", "assets", "x.png"))).toBe(true);
    expect(isInsideArtifacts("/tmp/outside.png")).toBe(false);
  });
});
