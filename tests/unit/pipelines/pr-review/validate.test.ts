import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePrAnalystOutput } from "@src/pipelines/pr-review/validate.js";

const VALID_REPORT = {
  subagent_id: "group-01",
  files_reviewed: ["src/a.ts"],
  dimensions: ["correctness"],
  issues: [],
  notes: "",
};

async function makeArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goodboy-pr-analyst-"));
  await mkdir(path.join(dir, "reports"));
  await writeFile(path.join(dir, "summary.md"), "summary\n");
  await writeValidSession(dir);
  await writeFile(path.join(dir, "review-plan.json"), JSON.stringify({
    groups: [{
      id: "group-01",
      files: ["src/a.ts"],
      dimensions: ["correctness"],
      focus: "check the changed file",
    }],
    skipped: [],
    focus_notes: "small PR",
  }));
  await writeFile(path.join(dir, "reports", "group-01.json"), JSON.stringify(VALID_REPORT));
  await writeFile(path.join(dir, "reports", "holistic.json"), JSON.stringify({
    ...VALID_REPORT,
    subagent_id: "holistic",
    dimensions: ["tests"],
  }));
  return dir;
}

describe("validatePrAnalystOutput", () => {
  it("accepts a complete analyst artifact set", async () => {
    const dir = await makeArtifactsDir();

    await expect(validatePrAnalystOutput(dir)).resolves.toEqual({ valid: true });
  });

  it("rejects a missing planned group report", async () => {
    const dir = await makeArtifactsDir();
    await writeFile(path.join(dir, "review-plan.json"), JSON.stringify({
      groups: [
        {
          id: "group-01",
          files: ["src/a.ts"],
          dimensions: ["correctness"],
          focus: "check the changed file",
        },
        {
          id: "group-02",
          files: ["src/b.ts"],
          dimensions: ["style"],
          focus: "check another file",
        },
      ],
      skipped: [],
      focus_notes: "small PR",
    }));

    const result = await validatePrAnalystOutput(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("group-02.json");
  });

  it("rejects invalid report JSON", async () => {
    const dir = await makeArtifactsDir();
    await writeFile(path.join(dir, "reports", "group-01.json"), "not json");

    const result = await validatePrAnalystOutput(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid JSON");
  });

  it("rejects a subagent call that used the user reviewer agent", async () => {
    const dir = await makeArtifactsDir();
    await writeSession(dir, {
      tasks: [{ agent: "reviewer", task: "review this", output: "reports/group-01.json" }],
      concurrency: 1,
      agentScope: "project",
    });

    const result = await validatePrAnalystOutput(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("project codebase-explorer");
  });

  it("rejects a subagent discovery/list call", async () => {
    const dir = await makeArtifactsDir();
    await writeSession(dir, { action: "list", agentScope: "project" });

    const result = await validatePrAnalystOutput(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("action mode");
  });
});

async function writeValidSession(dir: string): Promise<void> {
  await writeSession(dir, {
    tasks: [
      { agent: "codebase-explorer", task: "review group", output: path.join(dir, "reports", "group-01.json") },
      { agent: "codebase-explorer", task: "review holistic", output: path.join(dir, "reports", "holistic.json") },
    ],
    concurrency: 2,
    agentScope: "project",
  });
}

async function writeSession(dir: string, subagentArgs: unknown): Promise<void> {
  await writeFile(path.join(dir, "pr_analyst.session.jsonl"), `${JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          arguments: subagentArgs,
        },
      ],
    },
  })}\n`);
}
