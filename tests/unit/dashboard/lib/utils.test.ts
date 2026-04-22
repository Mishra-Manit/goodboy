import { describe, it, expect } from "vitest";
import { cn, shortId } from "@dashboard/lib/utils.js";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", false, "b", null, "c", undefined)).toBe("a b c");
  });
  it("handles arrays and objects (clsx semantics)", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });
  it("returns empty string for no truthy inputs", () => {
    expect(cn(false, null, undefined)).toBe("");
  });
});

describe("shortId", () => {
  it("returns first 8 chars", () => {
    expect(shortId("a1b2c3d4-5678-90ab-cdef-123456789012")).toBe("a1b2c3d4");
  });
  it("returns the full string when shorter than 8", () => {
    expect(shortId("abc")).toBe("abc");
  });
});
