import { describe, expect, it } from "vitest";
import { summarizeSessionEntries } from "@src/core/pi/session-summary";
import type { FileEntry } from "@src/shared/contracts/session";

describe("summarizeSessionEntries", () => {
  it("extracts session metrics from assistant messages", () => {
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
          model: "model-a",
          stopReason: "toolUse",
          timestamp: 0,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
        },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-05-16T00:00:03.000Z",
        message: {
          role: "assistant",
          api: "chat",
          provider: "test",
          model: "model-b",
          stopReason: "stop",
          timestamp: 0,
          usage: {
            input: 4,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          },
          content: [{ type: "text", text: "done" }],
        },
      },
    ];

    expect(summarizeSessionEntries(entries)).toEqual({
      piSessionId: "sess-1",
      model: "model-b",
      durationMs: 3000,
      totalTokens: 12,
      costUsd: "0.030000",
      toolCallCount: 1,
    });
  });
});
