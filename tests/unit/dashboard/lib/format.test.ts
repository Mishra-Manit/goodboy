import { describe, it, expect } from "vitest";
import {
  formatDate,
  timeAgo,
  formatDuration,
  formatMs,
  formatTokens,
  formatTime,
} from "@dashboard/lib/format.js";

const NOW_ISO = "2026-04-21T12:00:00Z";
const NOW_MS = new Date(NOW_ISO).getTime();

describe("timeAgo", () => {
  it("returns seconds under a minute", () => {
    expect(timeAgo("2026-04-21T11:59:30Z", NOW_MS)).toBe("30s ago");
  });
  it("returns minutes under an hour", () => {
    expect(timeAgo("2026-04-21T11:55:00Z", NOW_MS)).toBe("5m ago");
  });
  it("returns hours under a day", () => {
    expect(timeAgo("2026-04-21T09:00:00Z", NOW_MS)).toBe("3h ago");
  });
  it("returns days", () => {
    expect(timeAgo("2026-04-20T12:00:00Z", NOW_MS)).toBe("1d ago");
  });
  it("handles 0s", () => {
    expect(timeAgo(NOW_ISO, NOW_MS)).toBe("0s ago");
  });
});

describe("formatMs", () => {
  it.each<[number, string]>([
    [0, "0ms"],
    [230, "230ms"],
    [1000, "1s"],
    [45_000, "45s"],
    [60_000, "1m"],
    [150_000, "2m 30s"],
    [3_600_000, "1h 0m"],
    [4_500_000, "1h 15m"],
  ])("formatMs(%i) === %s", (ms, expected) => {
    expect(formatMs(ms)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it("computes elapsed ms between two ISO timestamps", () => {
    expect(formatDuration("2026-04-21T12:00:00Z", "2026-04-21T12:00:45Z")).toBe("45s");
  });
});

describe("formatTokens", () => {
  it("returns plain number under 1000", () => {
    expect(formatTokens(500)).toBe("500");
  });
  it("compacts thousands with one decimal", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12_345)).toBe("12.3k");
  });
  it("handles exactly 1000", () => {
    expect(formatTokens(1000)).toBe("1.0k");
  });
});

describe("formatTime", () => {
  it("returns HH:MM:SS", () => {
    expect(formatTime("2026-04-21T12:34:56Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("returns empty string on empty input", () => {
    expect(formatTime("")).toBe("");
  });
});

describe("formatDate", () => {
  it("returns a short date string", () => {
    const out = formatDate("2026-04-21T12:34:56Z");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
