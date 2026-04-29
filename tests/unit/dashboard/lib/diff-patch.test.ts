import { describe, expect, it } from "vitest";
import { findPatchForFile, splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";

describe("splitUnifiedDiffByFile", () => {
  it("returns an empty array for empty input", () => {
    expect(splitUnifiedDiffByFile("\n  \n")).toEqual([]);
  });

  it("splits a single-file diff", () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    expect(splitUnifiedDiffByFile(diff)).toEqual([{ filePath: "src/a.ts", patch: diff }]);
  });

  it("splits a multi-file diff", () => {
    const first = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n";
    const second = "diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-b\n+B\n";

    expect(splitUnifiedDiffByFile(first + second)).toEqual([
      { filePath: "src/a.ts", patch: first },
      { filePath: "src/b.ts", patch: second },
    ]);
  });

  it("uses the b-side path for renames", () => {
    const diff = "diff --git a/src/old.ts b/src/new.ts\nrename from src/old.ts\nrename to src/new.ts\n";

    expect(splitUnifiedDiffByFile(diff)[0]?.filePath).toBe("src/new.ts");
  });
});

describe("findPatchForFile", () => {
  it("returns null when the file is absent", () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n";

    expect(findPatchForFile(diff, "src/missing.ts")).toBeNull();
  });
});
