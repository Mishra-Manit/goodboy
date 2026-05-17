import { describe, expect, it } from "vitest";
import { parseSubagentRuns } from "@src/core/subagents/session-parser";
import type { FileEntry } from "@src/shared/contracts/session";

describe("parseSubagentRuns", () => {
  it("extracts task prompts and paired raw result text", () => {
    const entries: FileEntry[] = [
      { type: "session", id: "sess-1", timestamp: "2026-05-16T00:00:00.000Z", cwd: "/tmp" },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-05-16T00:00:01.000Z",
        message: {
          role: "assistant",
          api: "chat",
          provider: "test",
          model: "m",
          stopReason: "toolUse",
          timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks: [
            { agent: "codebase-explorer", task: "inspect api" },
            { agent: "codebase-explorer", task: "inspect db" },
          ] } }],
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "m1",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "subagent",
          isError: false,
          timestamp: 0,
          content: [{ type: "text", text: "raw final output" }],
        },
      },
    ];

    expect(parseSubagentRuns(entries)).toMatchObject([
      { agentName: "codebase-explorer", runIndex: 0, prompt: "inspect api", resultText: "raw final output", status: "complete" },
      { agentName: "codebase-explorer", runIndex: 1, prompt: "inspect db", resultText: "raw final output", status: "complete" },
    ]);
  });
});
