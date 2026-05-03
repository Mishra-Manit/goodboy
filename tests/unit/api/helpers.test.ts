import { describe, expect, it } from "vitest";
import { isSafeArtifactName } from "@src/api/helpers.js";

describe("isSafeArtifactName", () => {
  it.each(["plan.md", "report-1.json", "pr_context.updated.json", "a"])(
    "accepts %s",
    (name) => {
      expect(isSafeArtifactName(name)).toBe(true);
    },
  );

  it.each(["..", ".", ".env", "foo/bar", "foo\\bar", "foo%2fbar", ""])(
    "rejects %s",
    (name) => {
      expect(isSafeArtifactName(name)).toBe(false);
    },
  );
});
