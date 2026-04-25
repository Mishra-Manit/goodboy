import { describe, it, expect } from "vitest";
import { TERMINAL_STATUSES, isTerminalStatus } from "@src/shared/types.js";

describe("isTerminalStatus", () => {
  it("returns true for the canonical terminal statuses", () => {
    expect(TERMINAL_STATUSES.every((status) => isTerminalStatus(status))).toBe(true);
  });

  it("returns false for non-terminal task statuses", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});
