import { describe, it, expect } from "vitest";
import {
  visibleEntries,
  dedupeById,
  buildToolResultIndex,
  joinText,
} from "@dashboard/components/log-viewer/helpers.js";
import type { FileEntry, SessionEntry } from "@dashboard/lib/api";

// Test fixtures are intentionally minimal: the helpers only read a handful
// of fields, so we cast from `unknown` to keep the fixture footprint small.

const header = { type: "session", id: "s1", version: 3 } as unknown as FileEntry;
const modelChange = {
  type: "model_change",
  id: "mc1",
  parentId: null,
  timestamp: "t",
  provider: "p",
  modelId: "m",
} as unknown as FileEntry;
const userMsg = {
  type: "message",
  id: "m1",
  parentId: null,
  timestamp: "t",
  message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
} as unknown as FileEntry;
const assistantMsg = {
  type: "message",
  id: "m2",
  parentId: null,
  timestamp: "t",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }],
    timestamp: 0,
  },
} as unknown as FileEntry;
const toolResult = {
  type: "message",
  id: "m3",
  parentId: null,
  timestamp: "t",
  message: {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  },
} as unknown as FileEntry;

describe("visibleEntries", () => {
  it("drops session + model_change, keeps messages", () => {
    const out = visibleEntries([header, modelChange, userMsg, assistantMsg]);
    expect(out.map((e) => e.id)).toEqual(["m1", "m2"]);
  });

  it("returns empty array when every entry is hidden", () => {
    expect(visibleEntries([header, modelChange])).toHaveLength(0);
  });
});

describe("dedupeById", () => {
  it("preserves first-seen order and drops repeats", () => {
    const out = dedupeById([userMsg, userMsg, toolResult]);
    expect(out.map((e) => e.id)).toEqual(["m1", "m3"]);
  });

  it("keeps entries without an id by falling back to type+index", () => {
    const noId = { type: "session", version: 3 } as unknown as FileEntry;
    const out = dedupeById([noId, noId]);
    // Fallback keys include the index so both entries survive.
    expect(out).toHaveLength(2);
  });
});

describe("buildToolResultIndex", () => {
  it("maps toolCallId -> tool result entry", () => {
    const entries = [userMsg, toolResult] as SessionEntry[];
    const idx = buildToolResultIndex(entries);
    expect(idx.get("tc1")?.id).toBe("m3");
  });

  it("ignores non-toolResult messages", () => {
    const idx = buildToolResultIndex([userMsg, assistantMsg] as SessionEntry[]);
    expect(idx.size).toBe(0);
  });
});

describe("joinText", () => {
  it("concatenates text blocks, skips images", () => {
    const blocks = [
      { type: "text", text: "hello " },
      { type: "image", data: "base64" },
      { type: "text", text: "world" },
    ];
    expect(joinText(blocks)).toBe("hello world");
  });

  it("returns empty string when no text blocks", () => {
    expect(joinText([{ type: "image", data: "x" }])).toBe("");
  });

  it("skips text blocks with non-string text", () => {
    const blocks = [
      { type: "text" }, // missing text
      { type: "text", text: "ok" },
    ];
    expect(joinText(blocks)).toBe("ok");
  });
});
