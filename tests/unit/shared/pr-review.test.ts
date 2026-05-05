import { describe, expect, it } from "vitest";
import { prReviewArtifactSchema, type PrReviewArtifact } from "@src/shared/contracts/pr-review.js";

const validArtifact: PrReviewArtifact = {
  prTitle: "Add review page",
  headSha: "abc123456789",
  summary: "This review explains the PR.",
  chapters: [
    {
      id: "main-change",
      title: "Main change",
      narrative: "This group carries the core behavior.",
      files: [{ path: "src/a.ts", narrative: "This file carries the core behavior." }],
      annotations: [
        {
          filePath: "src/a.ts",
          line: 12,
          kind: "concern",
          title: "Check the boundary",
          body: "This line needs another guard.",
        },
      ],
    },
  ],
};

describe("prReviewArtifactSchema", () => {
  it("accepts a valid artifact", () => {
    expect(prReviewArtifactSchema.safeParse(validArtifact).success).toBe(true);
  });

  it("rejects leading-dash slugs", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [{ ...validArtifact.chapters[0], id: "-bad-slug" }],
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

  it("rejects duplicate chapter ids", () => {
    const result = prReviewArtifactSchema.safeParse({
      ...validArtifact,
      chapters: [validArtifact.chapters[0], { ...validArtifact.chapters[0] }],
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
