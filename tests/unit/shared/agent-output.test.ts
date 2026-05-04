import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineJsonOutput,
  defineTextOutput,
  finalLineResponsePromptBlock,
  finalResponsePromptBlock,
  outputContractPromptBlock,
  parseBareFinalJson,
  parseFinalLineJson,
  prCreationFinalResponseContract,
  prCreationFinalResponseSchema,
  reviewChatFinalResponseContract,
  reviewChatFinalResponseSchema,
  stageCompleteFinalResponseSchema,
  validateFileOutput,
} from "@src/shared/agent-output/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-output-"));
  tempDirs.push(dir);
  return dir;
}

describe("agent output validation", () => {
  it("validates non-empty text and rejects empty text", async () => {
    const dir = await tempDir();
    const output = defineTextOutput({
      id: "test.text",
      path: () => "out.md",
      prompt: { name: "text output" },
    }).resolve(dir, undefined);

    await writeFile(output.path, "hello", "utf8");
    await expect(validateFileOutput(output)).resolves.toMatchObject({ valid: true, data: "hello" });

    await writeFile(output.path, "   ", "utf8");
    await expect(validateFileOutput(output)).resolves.toMatchObject({ valid: false, soft: false });
  });

  it("honors optional and softRequired missing-file policies", async () => {
    const dir = await tempDir();
    const optional = defineTextOutput({
      id: "test.optional",
      policy: "optional",
      path: () => "optional.md",
      prompt: { name: "optional" },
    }).resolve(dir, undefined);
    const soft = defineTextOutput({
      id: "test.soft",
      policy: "softRequired",
      path: () => "soft.md",
      prompt: { name: "soft" },
    }).resolve(dir, undefined);

    await expect(validateFileOutput(optional)).resolves.toEqual({ valid: true });
    await expect(validateFileOutput(soft)).resolves.toMatchObject({ valid: false, soft: true });
  });

  it("rejects unknown keys with strict JSON schemas", async () => {
    const dir = await tempDir();
    const output = defineJsonOutput({
      id: "test.json",
      path: () => "out.json",
      schema: z.object({ ok: z.literal(true) }).strict(),
      prompt: { name: "json output" },
    }).resolve(dir, undefined);

    await writeFile(output.path, JSON.stringify({ ok: true, extra: false }), "utf8");
    await expect(validateFileOutput(output)).resolves.toMatchObject({ valid: false, soft: false });

    await writeFile(output.path, JSON.stringify({ ok: true }), "utf8");
    await expect(validateFileOutput(output)).resolves.toMatchObject({ valid: true, data: { ok: true } });
  });
});

describe("agent output prompts", () => {
  it("renders paths, skeletons, and exact final-response JSON", () => {
    const output = defineJsonOutput({
      id: "test.plan",
      path: () => "plan.json",
      schema: z.object({ status: z.literal("ok") }).strict(),
      prompt: { name: "plan", skeleton: '{"status":"ok"}' },
    }).resolve("/tmp/task", undefined);

    const block = outputContractPromptBlock([output]);
    expect(block).toContain("/tmp/task/plan.json");
    expect(block).toContain('{"status":"ok"}');
    expect(block).not.toContain("```");
    expect(finalResponsePromptBlock()).toContain('{"status":"complete"}');
    expect(finalResponsePromptBlock(prCreationFinalResponseContract)).toContain('"prUrl"');
    expect(finalLineResponsePromptBlock(reviewChatFinalResponseContract)).toContain("final line");
  });
});

describe("agent final responses", () => {
  it("parses only exact bare stage-complete JSON", () => {
    expect(parseBareFinalJson('{"status":"complete"}', stageCompleteFinalResponseSchema)).toEqual({ status: "complete" });
    expect(parseBareFinalJson('done\n{"status":"complete"}', stageCompleteFinalResponseSchema)).toBeNull();
    expect(parseBareFinalJson('{"status":"complete","extra":true}', stageCompleteFinalResponseSchema)).toBeNull();
  });

  it("parses PR creation JSON with a required GitHub PR URL", () => {
    expect(parseBareFinalJson(
      '{"status":"complete","prUrl":"https://github.com/acme/widgets/pull/42"}',
      prCreationFinalResponseSchema,
    )).toEqual({ status: "complete", prUrl: "https://github.com/acme/widgets/pull/42" });
    expect(parseBareFinalJson(
      '{"status":"complete","prUrl":"https://github.com/acme/widgets/issues/42"}',
      prCreationFinalResponseSchema,
    )).toBeNull();
  });

  it("parses review-chat JSON only on the final line", () => {
    expect(parseFinalLineJson('reply\n{"status":"complete","changed":false}', reviewChatFinalResponseSchema)).toEqual({
      status: "complete",
      changed: false,
    });
    expect(parseFinalLineJson('{"status":"complete","changed":false}\nreply', reviewChatFinalResponseSchema)).toBeNull();
  });
});
