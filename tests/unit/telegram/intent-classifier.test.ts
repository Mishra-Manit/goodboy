import { describe, it, expect, vi, beforeEach } from "vitest";

// Vitest 4 reports spy-tracked rejected promises as unhandled even when
// callers catch them (vitest-dev/vitest#9024). Skip the `vi.fn` spy and use
// a plain mutable handler so rejections live only on the awaited promise
// the test itself receives.
const { llmHandler } = vi.hoisted(() => ({
  llmHandler: {
    calls: [] as Array<unknown>,
    impl: async (_opts: unknown): Promise<unknown> => ({}),
  },
}));

vi.mock("@src/shared/llm.js", () => ({
  LIGHT_MODEL: "light",
  structuredOutput: (opts: unknown) => {
    llmHandler.calls.push(opts);
    return llmHandler.impl(opts);
  },
}));

import { classifyMessage } from "@src/telegram/intent-classifier.js";

beforeEach(() => {
  llmHandler.calls.length = 0;
  llmHandler.impl = async () => ({});
});

describe("classifyMessage", () => {
  it("routes a coding_task intent through unchanged", async () => {
    llmHandler.impl = async () => ({
      type: "coding_task",
      repo: "myrepo",
      description: "add dark mode",
    });
    const intent = await classifyMessage("myrepo add dark mode", ["myrepo"]);
    expect(intent).toEqual({
      type: "coding_task",
      repo: "myrepo",
      description: "add dark mode",
    });
  });

  it("falls back to { type: 'unknown', rawText } when the LLM throws", async () => {
    llmHandler.impl = async () => {
      throw new Error("llm down");
    };
    const intent = await classifyMessage("hi", ["myrepo"]);
    expect(intent).toEqual({ type: "unknown", rawText: "hi" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["pr_review", { type: "pr_review", repo: "myrepo", prIdentifier: "#42" }],
    ["codebase_question", { type: "codebase_question", repo: "myrepo", question: "what does X do" }],
    ["task_status", { type: "task_status" }],
    ["task_status with prefix", { type: "task_status", taskPrefix: "abcd1234" }],
    ["task_cancel", { type: "task_cancel", taskPrefix: "abcd1234" }],
    ["task_retry", { type: "task_retry", taskPrefix: "abcd1234" }],
    ["unknown", { type: "unknown", rawText: "lolwat" }],
  ])("accepts a %s intent from the LLM", async (_label, payload) => {
    llmHandler.impl = async () => payload;
    const intent = await classifyMessage("msg", ["myrepo"]);
    expect(intent.type).toBe(payload.type);
  });

  it("passes the repo names into structuredOutput's system prompt", async () => {
    llmHandler.impl = async () => ({ type: "unknown", rawText: "x" });
    await classifyMessage("x", ["alpha", "beta"]);
    const callArg = llmHandler.calls[0] as { system: string };
    expect(callArg.system).toContain("alpha");
    expect(callArg.system).toContain("beta");
  });
});
