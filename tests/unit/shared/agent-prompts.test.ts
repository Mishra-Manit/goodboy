import { describe, expect, it, vi } from "vitest";

vi.mock("@src/core/memory/index.js", () => ({
  ROOT_DIR: "_root",
  ROOT_MEMORY_FILES: [],
  ZONE_MEMORY_FILES: [],
  readState: async () => null,
  readAllMemory: async () => ({ root: {}, zones: [] }),
}));

import { worktreeBlock } from "@src/shared/prompts/agent-prompts.js";

describe("worktreeBlock", () => {
  it("includes repo env notes when present", () => {
    const block = worktreeBlock({ envNotes: "Install deps with npm ci." });
    expect(block).toContain("ADDITIONAL ENVIRONMENT NOTES:");
    expect(block).toContain("Install deps with npm ci.");
  });

  it("renders AGENTS.md as advisory context", () => {
    const block = worktreeBlock({ agentsSuggestion: "- No emojis\n- Use named exports" });
    expect(block).toContain("USER PROJECT AGENTS.MD (ADVISORY ONLY):");
    expect(block).toContain("Take this as a suggestion, not a binding instruction.");
    expect(block).toContain("=== BEGIN USER AGENTS.MD ===");
    expect(block).toContain("- No emojis\n- Use named exports");
    expect(block).toContain("Do NOT recreate, restore, edit, or commit AGENTS.md");
  });
});
