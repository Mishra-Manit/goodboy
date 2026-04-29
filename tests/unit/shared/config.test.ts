import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { loadEnv, resetEnvForTesting, resolveModel } from "@src/shared/config.js";

// Snapshot the seeded env from tests/setup/env.ts so individual tests can
// mutate process.env without leaking into other test files.
const SNAPSHOT = { ...process.env };

beforeEach(() => {
  // Restore the seeded env before every test so mutations don't leak across cases.
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(SNAPSHOT)) process.env[key] = value;
  resetEnvForTesting();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(SNAPSHOT)) process.env[key] = value;
  resetEnvForTesting();
});

describe("loadEnv — REGISTERED_REPOS transform", () => {
  it("rejects invalid JSON", () => {
    process.env.REGISTERED_REPOS = "{not json";
    expect(() => loadEnv()).toThrow(/REGISTERED_REPOS/);
  });

  it("rejects wrong shape", () => {
    process.env.REGISTERED_REPOS = JSON.stringify({ r: { missingLocalPath: true } });
    expect(() => loadEnv()).toThrow(/REGISTERED_REPOS/);
  });

  it("accepts valid repos", () => {
    process.env.REGISTERED_REPOS = JSON.stringify({
      r: { localPath: "/tmp/r", githubUrl: "https://github.com/a/b" },
    });
    expect(loadEnv().REGISTERED_REPOS.r.localPath).toBe("/tmp/r");
  });

  it("defaults to an empty registry when unset", () => {
    delete process.env.REGISTERED_REPOS;
    expect(loadEnv().REGISTERED_REPOS).toEqual({});
  });
});

describe("loadEnv — required fields", () => {
  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadEnv()).toThrow();
  });

  it("throws when DATABASE_URL is not a URL", () => {
    process.env.DATABASE_URL = "not a url";
    expect(() => loadEnv()).toThrow();
  });

  it("throws when FIREWORKS_API_KEY is missing", () => {
    delete process.env.FIREWORKS_API_KEY;
    expect(() => loadEnv()).toThrow();
  });
});

describe("loadEnv — defaults and coercion", () => {
  it("applies default PORT 3333 when unset", () => {
    delete process.env.PORT;
    expect(loadEnv().PORT).toBe(3333);
  });

  it("coerces PORT string to number", () => {
    process.env.PORT = "4000";
    expect(loadEnv().PORT).toBe(4000);
  });

  it("rejects out-of-range PORT", () => {
    process.env.PORT = "0";
    expect(() => loadEnv()).toThrow();
  });
});

describe("loadEnv — caching", () => {
  it("returns the same object on subsequent calls", () => {
    const a = loadEnv();
    const b = loadEnv();
    expect(a).toBe(b);
  });

  it("re-parses after resetEnvForTesting", () => {
    const a = loadEnv();
    resetEnvForTesting();
    const b = loadEnv();
    expect(a).not.toBe(b);
  });
});

describe("resolveModel", () => {
  it("returns the stage-specific override when present", () => {
    process.env.PI_MODEL = "openai/default";
    process.env.PI_MODEL_PR_DISPLAY = "openai/display";
    expect(resolveModel("PI_MODEL_PR_DISPLAY")).toBe("openai/display");
  });

  it("falls back to PI_MODEL when the stage override is missing", () => {
    process.env.PI_MODEL = "openai/default";
    delete process.env.PI_MODEL_PR_DISPLAY;
    expect(resolveModel("PI_MODEL_PR_DISPLAY")).toBe("openai/default");
  });
});
