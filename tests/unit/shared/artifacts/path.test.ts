import { describe, expect, it } from "vitest";
import { isSafeArtifactFilePath, normalizeArtifactFilePath } from "@src/shared/artifacts/path";

describe("artifact path safety", () => {
  it("accepts simple and nested relative paths", () => {
    expect(isSafeArtifactFilePath("plan.md")).toBe(true);
    expect(isSafeArtifactFilePath("reports/output.json")).toBe(true);
    expect(normalizeArtifactFilePath("reports\\output.json")).toBe("reports/output.json");
  });

  it("rejects absolute, traversal, empty, and hidden segments", () => {
    expect(isSafeArtifactFilePath("/tmp/x")).toBe(false);
    expect(isSafeArtifactFilePath("../x")).toBe(false);
    expect(isSafeArtifactFilePath("reports/../x")).toBe(false);
    expect(isSafeArtifactFilePath(".env")).toBe(false);
    expect(isSafeArtifactFilePath("reports/.hidden")).toBe(false);
  });
});
