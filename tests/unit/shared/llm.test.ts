import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { z } from "zod";
import {
  server,
  mockFireworksResponse,
  mockFireworksNetworkError,
} from "../../setup/msw.js";
import { complete, structuredOutput } from "@src/shared/llm.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("complete", () => {
  it("returns content on 200", async () => {
    mockFireworksResponse("hello");
    expect(await complete("hi")).toBe("hello");
  });

  it("returns null on non-2xx response", async () => {
    mockFireworksResponse(null, 500);
    expect(await complete("hi")).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFireworksNetworkError();
    expect(await complete("hi")).toBeNull();
  });

  it("trims leading/trailing whitespace", async () => {
    mockFireworksResponse("  hello  ");
    expect(await complete("hi")).toBe("hello");
  });
});

describe("structuredOutput", () => {
  const schema = z.object({ kind: z.literal("ok"), value: z.number() });

  it("returns the typed object on valid JSON matching the schema", async () => {
    mockFireworksResponse(JSON.stringify({ kind: "ok", value: 42 }));
    const out = await structuredOutput({ system: "s", prompt: "p", schema });
    expect(out.value).toBe(42);
  });

  it("throws on invalid JSON", async () => {
    mockFireworksResponse("not json");
    await expect(
      structuredOutput({ system: "s", prompt: "p", schema }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("throws on schema mismatch", async () => {
    mockFireworksResponse(JSON.stringify({ kind: "wrong", value: 1 }));
    await expect(
      structuredOutput({ system: "s", prompt: "p", schema }),
    ).rejects.toThrow(/schema validation/);
  });

  it("throws on empty response body", async () => {
    mockFireworksResponse(null);
    await expect(
      structuredOutput({ system: "s", prompt: "p", schema }),
    ).rejects.toThrow(/empty response/);
  });
});
