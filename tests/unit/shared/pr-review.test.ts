import { describe, expect, it } from "vitest";
import { prReviewArtifactSchema, type PrReviewArtifact } from "@src/shared/pr-review.js";

const validArtifact: PrReviewArtifact = {
  prTitle: "Add review page",
  headSha: "abc123456789",
  summary: "This review explains the PR.",
  chapters: [
    {
      id: "main-change",
      title: "Main change",
      files: ["src/a.ts"],
      rationale: "This file carries the core behavior.",
      annotations: [
        {
          filePath: "src/a.ts",
          side: "new",
          line: 12,
          kind: "concern",
          title: "Check the boundary",
          body: "This line needs another guard.",
        },
      ],
    },
  ],
  orderedChapterIds: ["main-change"],
};

describe("prReviewArtifactSchema", () => {
  it("accepts a valid artifact", () => {
    expect(prReviewArtifactSchema.safeParse(validArtifact).success).toBe(true);
  });

  it("rejects leading-dash slugs", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [{ ...validArtifact.chapters[0], id: "-bad-slug" }],
      orderedChapterIds: ["-bad-slug"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects line zero", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [
        {
          ...validArtifact.chapters[0],
          annotations: [{ ...validArtifact.chapters[0].annotations[0], line: 0 }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate ordered chapter ids", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [
        validArtifact.chapters[0],
        { ...validArtifact.chapters[0], id: "second-change", title: "Second change" },
      ],
      orderedChapterIds: ["main-change", "main-change"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects ordered chapter ids that are not real chapters", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      orderedChapterIds: ["missing-chapter"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects annotation files outside the chapter", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [
        {
          ...validArtifact.chapters[0],
          annotations: [
            {
              ...validArtifact.chapters[0].annotations[0],
              filePath: "src/other.ts",
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
