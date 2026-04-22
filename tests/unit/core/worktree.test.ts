import { describe, it, expect, vi, beforeEach } from "vitest";

// Same plain-handler pattern used in intent-classifier.test.ts to sidestep
// vitest 4's spy-tracked rejected-promise warnings (vitest-dev/vitest#9024).
const { llmHandler } = vi.hoisted(() => ({
  llmHandler: {
    impl: async (_opts: unknown): Promise<unknown> => ({ slug: "default-slug" }),
  },
}));

vi.mock("@src/shared/llm.js", () => ({
  LIGHT_MODEL: "light",
  structuredOutput: (opts: unknown) => llmHandler.impl(opts),
}));

// `src/core/subagents/index.ts` calls `resolveExtensionPath()` at module load
// time (via a top-level `const EXTENSION_PATH = resolveExtensionPath()`), which
// does a `require.resolve("pi-subagents/...")` that throws if the package is
// absent. Mock the whole module so the import never reaches that line.
vi.mock("@src/core/subagents/index.js", () => ({
  stageSubagentAssets: async () => undefined,
}));

import { generateBranchName } from "@src/core/worktree.js";

beforeEach(() => {
  llmHandler.impl = async () => ({ slug: "default-slug" });
});

describe("generateBranchName", () => {
  it("composes goodboy/<slug>-<taskId[:8]>", async () => {
    llmHandler.impl = async () => ({ slug: "add-dark-mode" });
    const name = await generateBranchName(
      "a1b2c3d4-5678-90ab-cdef-123456789012",
      "Add dark mode",
    );
    expect(name).toBe("goodboy/add-dark-mode-a1b2c3d4");
  });

  it("truncates slugs longer than the slug max length", async () => {
    // 60-char kebab slug; cap is 50.
    llmHandler.impl = async () => ({
      slug: "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-aa-bb-cc",
    });
    const name = await generateBranchName(
      "deadbeef-0000-0000-0000-000000000000",
      "x",
    );
    const slug = name.replace(/^goodboy\//, "").replace(/-deadbeef$/, "");
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it("retries up to three times when the LLM output fails the slug schema", async () => {
    let attempts = 0;
    llmHandler.impl = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("schema validation failed");
      return { slug: "third-time-lucky" };
    };
    const name = await generateBranchName(
      "a1b2c3d4-0000-0000-0000-000000000000",
      "x",
    );
    expect(attempts).toBe(3);
    expect(name).toBe("goodboy/third-time-lucky-a1b2c3d4");
  });

  it("throws after three failed attempts", async () => {
    llmHandler.impl = async () => {
      throw new Error("always fails");
    };
    await expect(
      generateBranchName("a1b2c3d4-0000-0000-0000-000000000000", "x"),
    ).rejects.toThrow(/Failed to generate a valid branch slug/);
  });
});
