import { describe, it, expect } from "vitest";
import { parseNwo, parsePrNumberFromUrl, parsePrIdentifier } from "@src/core/github.js";

describe("parseNwo", () => {
  it("parses https URL", () => {
    expect(parseNwo("https://github.com/foo/bar")).toBe("foo/bar");
  });
  it("parses https URL with .git suffix", () => {
    expect(parseNwo("https://github.com/foo/bar.git")).toBe("foo/bar");
  });
  it("parses ssh URL", () => {
    expect(parseNwo("git@github.com:foo/bar.git")).toBe("foo/bar");
  });
  it("parses ssh URL without .git", () => {
    expect(parseNwo("git@github.com:foo/bar")).toBe("foo/bar");
  });
  it("returns null for non-GitHub URL", () => {
    expect(parseNwo("https://gitlab.com/foo/bar")).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseNwo("not a url")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parseNwo("")).toBeNull();
  });
});

describe("parsePrNumberFromUrl", () => {
  it("extracts PR number", () => {
    expect(parsePrNumberFromUrl("https://github.com/foo/bar/pull/42")).toBe(42);
  });
  it("handles trailing path", () => {
    expect(parsePrNumberFromUrl("https://github.com/foo/bar/pull/42/files")).toBe(42);
  });
  it("returns null for non-PR URL", () => {
    expect(parsePrNumberFromUrl("https://github.com/foo/bar/issues/42")).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parsePrNumberFromUrl("nope")).toBeNull();
  });
});

describe("parsePrIdentifier", () => {
  it.each<[string, number]>([
    ["https://github.com/foo/bar/pull/42", 42],
    ["#42", 42],
    ["42", 42],
    ["pr/42", 42],
    ["PR #42", 42],
  ])("parses %s", (input, expected) => {
    expect(parsePrIdentifier(input)).toBe(expected);
  });
  it("returns null for pure garbage", () => {
    expect(parsePrIdentifier("abc")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parsePrIdentifier("")).toBeNull();
  });
});
