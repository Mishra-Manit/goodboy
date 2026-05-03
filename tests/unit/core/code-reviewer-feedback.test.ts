import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  appendCodeReviewerFeedback,
  codeReviewerFeedbackPath,
  ensureCodeReviewerFeedbackFile,
  listCodeReviewerFeedback,
  readCodeReviewerFeedback,
  renderCodeReviewerFeedbackBlock,
  updateCodeReviewerFeedback,
  type CodeReviewerFeedbackRule,
} from "@src/core/memory/code-reviewer-feedback.js";
import { memoryDir } from "@src/core/memory/index.js";

const REPO = "myrepo";

beforeEach(async () => {
  vi.useRealTimers();
  await rm(memoryDir(REPO), { recursive: true, force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(memoryDir(REPO), { recursive: true, force: true });
});

describe("code reviewer feedback memory", () => {
  it("creates a missing file as an empty array", async () => {
    await ensureCodeReviewerFeedbackFile(REPO);

    await expect(readFile(codeReviewerFeedbackPath(REPO), "utf8")).resolves.toBe("[]\n");
  });

  it("appends an active rule with generated id, timestamps, and source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));

    const rule = await appendCodeReviewerFeedback({
      repo: REPO,
      title: "Avoid helper docstrings",
      rule: "Do not add docstrings to small local helper functions.",
      scope: { type: "path", paths: ["src/pipelines/pr-review/**"] },
      source: { type: "github_comment", prNumber: 123, originalText: "never add docstrings here" },
    });

    expect(rule.id).toMatch(/^crf_[a-f0-9]{8}$/);
    expect(rule.status).toBe("active");
    expect(rule.createdAt).toBe("2026-05-01T00:00:00.000Z");
    expect(rule.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(rule.source).toEqual({
      type: "github_comment",
      prNumber: 123,
      originalText: "never add docstrings here",
    });

    const stored = JSON.parse(await readFile(codeReviewerFeedbackPath(REPO), "utf8"));
    expect(stored).toEqual([rule]);
  });

  it("lists active rules by default and can list all rules", async () => {
    const active = await appendCodeReviewerFeedback(seedInput("Active rule"));
    const inactive = await appendCodeReviewerFeedback(seedInput("Inactive rule"));
    await updateCodeReviewerFeedback({ repo: REPO, id: inactive.id, status: "inactive" });

    await expect(listCodeReviewerFeedback(REPO)).resolves.toEqual([active]);
    await expect(listCodeReviewerFeedback(REPO, "all")).resolves.toEqual([
      active,
      { ...inactive, status: "inactive", updatedAt: expect.any(String) },
    ]);
  });

  it("updates mutable fields and bumps updatedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const rule = await appendCodeReviewerFeedback(seedInput("Old title"));

    vi.setSystemTime(new Date("2026-05-01T00:01:00.000Z"));
    const updated = await updateCodeReviewerFeedback({
      repo: REPO,
      id: rule.id,
      status: "inactive",
      title: "New title",
      rule: "Prefer the existing review summary tone.",
      scope: { type: "review_behavior" },
    });

    expect(updated).toMatchObject({
      id: rule.id,
      status: "inactive",
      title: "New title",
      rule: "Prefer the existing review summary tone.",
      scope: { type: "review_behavior" },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:01:00.000Z",
    });
  });

  it("rejects updates for unknown ids", async () => {
    await expect(updateCodeReviewerFeedback({ repo: REPO, id: "crf_deadbeef", status: "inactive" }))
      .rejects.toThrow(/Unknown code reviewer feedback rule id/);
  });

  it("returns empty for invalid JSON reads but rejects mutations", async () => {
    await mkdir(memoryDir(REPO), { recursive: true });
    await writeFile(codeReviewerFeedbackPath(REPO), "not json", "utf8");

    await expect(readCodeReviewerFeedback(REPO)).resolves.toEqual([]);
    await expect(listCodeReviewerFeedback(REPO)).resolves.toEqual([]);
    await expect(appendCodeReviewerFeedback(seedInput("Cannot append"))).rejects.toThrow(/Malformed/);
    await expect(updateCodeReviewerFeedback({ repo: REPO, id: "crf_deadbeef", status: "inactive" }))
      .rejects.toThrow(/Malformed/);
  });

  it("renders active rules grouped by scope and excludes inactive rules", () => {
    const block = renderCodeReviewerFeedbackBlock([
      seedRule({ id: "crf_00000001", title: "Global rule", scope: { type: "global" } }),
      seedRule({
        id: "crf_00000002",
        title: "Path rule",
        scope: { type: "path", paths: ["src/a.ts", "src/b/**"] },
      }),
      seedRule({ id: "crf_00000003", title: "Behavior rule", scope: { type: "review_behavior" } }),
      seedRule({ id: "crf_00000004", title: "Inactive rule", status: "inactive" }),
    ]);

    expect(block).toContain("CODE REVIEWER FEEDBACK MEMORY");
    expect(block).toContain("Global:\n- crf_00000001 — Global rule");
    expect(block).toContain("Path:\n- crf_00000002 — Path rule (src/a.ts, src/b/**)");
    expect(block).toContain("Review behavior:\n- crf_00000003 — Behavior rule");
    expect(block).not.toContain("Inactive rule");
  });
});

function seedInput(title: string): Parameters<typeof appendCodeReviewerFeedback>[0] {
  return {
    repo: REPO,
    title,
    rule: `${title}: follow this durable reviewer preference.`,
    scope: { type: "global" },
    source: { type: "dashboard_chat", prNumber: 1, originalText: title },
  };
}

function seedRule(overrides: Partial<CodeReviewerFeedbackRule>): CodeReviewerFeedbackRule {
  return {
    id: "crf_abcdef12",
    status: "active",
    title: "Rule",
    rule: "Follow this rule.",
    scope: { type: "global" },
    source: { type: "github_comment", prNumber: 1, originalText: "remember this" },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}
