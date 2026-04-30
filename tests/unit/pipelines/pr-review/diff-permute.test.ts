import { describe, expect, it } from "vitest";
import {
  fileBlockPath,
  hashToSeed,
  permuteDiff,
  seededShuffle,
  splitDiffByFile,
} from "@src/pipelines/pr-review/diff-permute.js";

const BLOCK_A = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+a1\n";
const BLOCK_B = "diff --git a/src/b.ts b/src/b.ts\nindex 1..2 100644\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+b1\n";
const BLOCK_C = "diff --git a/src/c.ts b/src/c.ts\nindex 1..2 100644\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-c\n+c1\n";

function sortedBlocks(diff: string): string[] {
  return splitDiffByFile(diff).blocks.sort();
}

describe("diff permutation helpers", () => {
  it("keeps an empty diff as only v1", () => {
    expect(permuteDiff("", "task-1", 3)).toEqual([{ variant: 1, diff: "", fileOrder: [] }]);
  });

  it("keeps single-file variants byte-identical", () => {
    const variants = permuteDiff(BLOCK_A, "task-1", 3);
    expect(variants).toHaveLength(3);
    expect(variants.every((variant) => variant.diff === BLOCK_A)).toBe(true);
    expect(variants.every((variant) => variant.fileOrder.join(",") === "src/a.ts")).toBe(true);
  });

  it("preserves the same block set while shuffling multi-file variants", () => {
    const diff = `${BLOCK_A}${BLOCK_B}${BLOCK_C}`;
    const variants = permuteDiff(diff, "task-1", 3);

    expect(variants[0]?.diff).toBe(diff);
    expect(variants.map((variant) => sortedBlocks(variant.diff))).toEqual([
      [BLOCK_A, BLOCK_B, BLOCK_C].sort(),
      [BLOCK_A, BLOCK_B, BLOCK_C].sort(),
      [BLOCK_A, BLOCK_B, BLOCK_C].sort(),
    ]);
    expect(new Set(variants.map((variant) => variant.fileOrder.join("|"))).size).toBeGreaterThan(1);
  });

  it("uses task id as a deterministic shuffle seed", () => {
    const diff = `${BLOCK_A}${BLOCK_B}${BLOCK_C}`;
    expect(permuteDiff(diff, "task-abc", 3)).toEqual(permuteDiff(diff, "task-abc", 3));
    expect(permuteDiff(diff, "task-abc", 3)[1]?.fileOrder).not.toEqual(
      permuteDiff(diff, "task-def", 3)[1]?.fileOrder,
    );
  });

  it("preserves preamble before the first diff block", () => {
    const preamble = "metadata before diff\n";
    const variants = permuteDiff(`${preamble}${BLOCK_A}${BLOCK_B}`, "task-1", 2);
    expect(variants.every((variant) => variant.diff.startsWith(preamble))).toBe(true);
  });

  it("extracts b-side file paths and exposes deterministic primitives", () => {
    expect(fileBlockPath(BLOCK_A)).toBe("src/a.ts");
    expect(hashToSeed("same")).toBe(hashToSeed("same"));
    expect(seededShuffle([1, 2, 3, 4], 123)).toEqual(seededShuffle([1, 2, 3, 4], 123));
  });
});
