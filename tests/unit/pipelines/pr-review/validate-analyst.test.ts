import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validatePrAnalystArtifacts } from "@src/pipelines/pr-review/artifacts/validate-analyst.js";

async function makeArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "analyst-artifacts-"));
  await mkdir(join(dir, "reports"), { recursive: true });
  return dir;
}

async function writeValidPlan(dir: string): Promise<void> {
  await writeFile(join(dir, "review-plan.json"), JSON.stringify({
    groups: [
      {
        id: "group-01",
        files: ["src/a.ts"],
        dimensions: ["correctness"],
        focus: "Review runtime correctness for the changed API path.",
      },
      {
        id: "group-02",
        files: ["src/b.ts"],
        dimensions: ["tests"],
        focus: "Review test coverage for the new behavior.",
      },
    ],
    skipped: [],
    focus_notes: "Small PR with two risk surfaces.",
  }), "utf8");
}

async function writeReport(dir: string, id: string): Promise<void> {
  await writeFile(join(dir, "reports", `${id}.json`), JSON.stringify({
    subagent_id: id,
    files_reviewed: id === "holistic" ? [] : ["src/a.ts"],
    dimensions: ["correctness"],
    issues: [],
    notes: "",
  }), "utf8");
}

async function writeValidArtifacts(dir: string): Promise<void> {
  await writeValidPlan(dir);
  await writeFile(join(dir, "summary.md"), "Looks good with one follow-up.\n", "utf8");
  await writeReport(dir, "group-01");
  await writeReport(dir, "group-02");
  await writeReport(dir, "holistic");
}

describe("validatePrAnalystArtifacts", () => {
  it("accepts a complete analyst artifact set", async () => {
    const dir = await makeArtifactsDir();
    await writeValidArtifacts(dir);

    await expect(validatePrAnalystArtifacts(dir)).resolves.toEqual({ valid: true });
  });

  it("rejects a missing summary", async () => {
    const dir = await makeArtifactsDir();
    await writeValidPlan(dir);
    await writeReport(dir, "group-01");
    await writeReport(dir, "group-02");
    await writeReport(dir, "holistic");

    const result = await validatePrAnalystArtifacts(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("summary.md");
  });

  it("rejects a missing planned group report", async () => {
    const dir = await makeArtifactsDir();
    await writeValidPlan(dir);
    await writeFile(join(dir, "summary.md"), "Summary\n", "utf8");
    await writeReport(dir, "group-01");
    await writeReport(dir, "holistic");

    const result = await validatePrAnalystArtifacts(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("group-02.json");
  });

  it("rejects malformed report JSON", async () => {
    const dir = await makeArtifactsDir();
    await writeValidArtifacts(dir);
    await writeFile(join(dir, "reports", "group-01.json"), "{}\n{}", "utf8");

    const result = await validatePrAnalystArtifacts(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("malformed JSON");
  });

  it("rejects reports whose subagent_id does not match the filename", async () => {
    const dir = await makeArtifactsDir();
    await writeValidArtifacts(dir);
    await writeFile(join(dir, "reports", "group-02.json"), JSON.stringify({
      subagent_id: "wrong-id",
      files_reviewed: [],
      dimensions: ["correctness"],
      issues: [],
      notes: "",
    }), "utf8");

    const result = await validatePrAnalystArtifacts(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("subagent_id mismatch");
  });

  it("rejects empty group focus strings", async () => {
    const dir = await makeArtifactsDir();
    await writeFile(join(dir, "review-plan.json"), JSON.stringify({
      groups: [{ id: "group-01", files: ["src/a.ts"], dimensions: ["correctness"], focus: "" }],
      skipped: [],
      focus_notes: "notes",
    }), "utf8");
    await writeFile(join(dir, "summary.md"), "Summary\n", "utf8");
    await writeReport(dir, "group-01");
    await writeReport(dir, "holistic");

    const result = await validatePrAnalystArtifacts(dir);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("empty focus");
  });
});
