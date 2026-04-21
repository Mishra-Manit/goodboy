# Vitest Setup Implementation Plan

**Goal:** Stand up Vitest with unit + integration tests covering pure helpers, IO adapters with mocked boundaries, and the Hono HTTP/SSE surface. Excludes pi subprocess, pipeline orchestration, DB queries, dashboard hooks, and dashboard components.

**Approach:** Single Vitest project, `node` environment, co-located `.test.ts` files next to source. Three test categories: (1) pure functions with zero mocks, (2) IO adapters with `vi.mock` on the external boundary or msw for HTTP, (3) Hono routes via `testClient` with `db/queries` and pipelines mocked. Reuses the dashboard Vite config's path aliases so `@dashboard/*` and `@shared/*` imports resolve in dashboard pure-helper tests.

**Stack:** Vitest 1.x + `@vitest/coverage-v8` + `msw` 2.x. No jsdom, no testing-library, no PGlite.

---

## Phase 0 — Setup

### Task 0.1: Install dev dependencies

**Files:**
- Modify: `package.json`

**Implementation:**
Run:
```bash
npm install --save-dev vitest @vitest/coverage-v8 msw
```

Add scripts to `package.json`:
```json
"test":       "vitest run",
"test:watch": "vitest",
"test:cov":   "vitest run --coverage"
```

**Verify:**
```bash
npx vitest --version    # prints a version
npm test                # exits 0 with "No test files found"
```

**Commit:** `chore: add vitest and msw dev dependencies`

---

### Task 0.2: Root Vitest config

**Files:**
- Create: `vitest.config.ts`

**Implementation:**
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dashboard": path.resolve(__dirname, "dashboard/src"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "dashboard/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    setupFiles: ["tests/setup/env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/**/*.ts",
        "dashboard/src/components/log-viewer/helpers.ts",
        "dashboard/src/lib/format.ts",
        "dashboard/src/lib/task-grouping.ts",
        "dashboard/src/lib/utils.ts",
      ],
      exclude: [
        "src/core/pi/**",
        "src/core/stage.ts",
        "src/pipelines/**/pipeline.ts",
        "src/pipelines/pr-session/session.ts",
        "src/pipelines/pr-session/poller.ts",
        "src/db/queries.ts",
        "src/db/schema.ts",
        "src/db/index.ts",
        "src/index.ts",
        "**/*.test.ts",
      ],
    },
  },
});
```

**Verify:**
```bash
npm test   # still exits 0, no files found
```

**Commit:** `chore: add vitest config with node env and path aliases`

---

### Task 0.3: Test env setup file

**Files:**
- Create: `tests/setup/env.ts`

**Implementation:**
Stubs every env var required by `envSchema` in `src/shared/config.ts` so `loadEnv()` succeeds inside tests without a real `.env`.

```ts
process.env.INSTANCE_ID ??= "test";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_USER_ID ??= "1";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.GH_TOKEN ??= "test-gh-token";
process.env.FIREWORKS_API_KEY ??= "test-fireworks-key";
process.env.REGISTERED_REPOS ??= JSON.stringify({
  myrepo: { localPath: "/tmp/myrepo", githubUrl: "https://github.com/test/myrepo" },
  other:  { localPath: "/tmp/other",  githubUrl: "https://github.com/test/other.git" },
});
```

**Verify:** Tasks in Phase 1 will load `loadEnv()` without crashing.

**Commit:** `chore: add test env setup file`

---

### Task 0.4: Update AGENTS.md Definition of Done

**Files:**
- Modify: `AGENTS.md`

**Implementation:**
Under "Definition of Done", add item between existing #1 and #2:

```
2. `npm test` exits 0 (all unit and integration tests pass).
```

Renumber subsequent items. Update the "Testing" section at the bottom to reflect that Vitest is now wired with concrete test scopes.

**Verify:** `grep "npm test" AGENTS.md` finds the new line.

**Commit:** `docs: require npm test in definition of done`

---

## Phase 1 — Pure function tests

No mocks. One `.test.ts` co-located next to each source file.

### Task 1.1: `core/github.ts` parsers

**Files:**
- Create: `src/core/github.test.ts`

**Implementation:**
```ts
import { describe, it, expect } from "vitest";
import { parseNwo, parsePrNumberFromUrl, parsePrIdentifier } from "./github.js";

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
  it("returns null for non-GitHub URL", () => {
    expect(parseNwo("https://gitlab.com/foo/bar")).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseNwo("not a url")).toBeNull();
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
  it.each([
    ["https://github.com/foo/bar/pull/42", 42],
    ["#42", 42],
    ["42", 42],
    ["pr/42", 42],
  ])("parses %s", (input, expected) => {
    expect(parsePrIdentifier(input)).toBe(expected);
  });
  it("returns null for garbage", () => {
    expect(parsePrIdentifier("abc")).toBeNull();
  });
});
```

**Verify:** `npx vitest run src/core/github.test.ts` — all pass.

**Commit:** `test: cover github URL parsers`

---

### Task 1.2: `core/session-file.ts` pure parts + read

**Files:**
- Create: `src/core/session-file.test.ts`
- Create: `tests/fixtures/sessions/planner.jsonl` (capture manually, see below)

**Implementation:**

Fixture prep: run the real app once, copy one `artifacts/<id>/planner.session.jsonl` into `tests/fixtures/sessions/planner.jsonl`. If not available yet, hand-craft a minimal valid fixture:
```jsonl
{"type":"session","id":"s1","version":3,"createdAt":"2026-04-21T00:00:00Z"}
{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
```

Test file:
```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  taskSessionPath,
  prSessionPath,
  readSessionFile,
} from "./session-file.js";

describe("path helpers", () => {
  it("taskSessionPath composes artifactsDir/taskId/<stage>.session.jsonl", () => {
    const p = taskSessionPath("abc-123", "planner");
    expect(p.endsWith("/abc-123/planner.session.jsonl")).toBe(true);
  });
  it("prSessionPath composes prSessionsDir/<id>.jsonl", () => {
    const p = prSessionPath("xyz");
    expect(p.endsWith("/xyz.jsonl")).toBe(true);
  });
});

describe("readSessionFile", () => {
  it("returns [] when file missing", async () => {
    const entries = await readSessionFile("/tmp/does-not-exist.jsonl");
    expect(entries).toEqual([]);
  });

  it("parses valid JSONL and skips malformed lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", id: "s1", version: 3 }),
        "{ not json",
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [] } }),
        "",
      ].join("\n"),
    );
    const entries = await readSessionFile(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("session");
    expect(entries[1].type).toBe("message");
  });

  it("throws when session version exceeds CURRENT_SESSION_VERSION", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "s", version: 999 }));
    await expect(readSessionFile(file)).rejects.toThrow(/Unsupported pi session version/);
  });

  it("parses the real fixture without throwing", async () => {
    const entries = await readSessionFile("tests/fixtures/sessions/planner.jsonl");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].type).toBe("session");
  });
});
```

**Verify:** `npx vitest run src/core/session-file.test.ts`.

**Commit:** `test: cover session-file read + path helpers`

---

### Task 1.3: `core/worktree.ts#generateBranchName`

**Files:**
- Create: `src/core/worktree.test.ts`

**Implementation:**
```ts
import { describe, it, expect } from "vitest";
import { generateBranchName } from "./worktree.js";

describe("generateBranchName", () => {
  it("lowercases and slugs the description", () => {
    expect(generateBranchName("a1b2c3d4-5678-90ab-cdef-123456789012", "Add Dark Mode"))
      .toBe("goodboy/add-dark-mode-a1b2c3d4");
  });
  it("caps slug at 40 chars", () => {
    const long = "x".repeat(100);
    const name = generateBranchName("a1b2c3d4-0000-0000-0000-000000000000", long);
    const slug = name.replace(/^goodboy\//, "").replace(/-a1b2c3d4$/, "");
    expect(slug.length).toBeLessThanOrEqual(40);
  });
  it("falls back to 'task' for empty slug", () => {
    expect(generateBranchName("a1b2c3d4-0000-0000-0000-000000000000", "!!!"))
      .toBe("goodboy/task-a1b2c3d4");
  });
  it("uses first 8 chars of taskId as suffix", () => {
    const name = generateBranchName("deadbeef-0000-0000-0000-000000000000", "hi");
    expect(name.endsWith("-deadbeef")).toBe(true);
  });
});
```

**Verify:** `npx vitest run src/core/worktree.test.ts`.

**Commit:** `test: cover generateBranchName`

---

### Task 1.4: `shared/repos.ts`

**Files:**
- Create: `src/shared/repos.test.ts`

**Implementation:**
```ts
import { describe, it, expect } from "vitest";
import { getRepo, listRepoNames, buildPrUrl } from "./repos.js";

// tests/setup/env.ts seeds REGISTERED_REPOS with "myrepo" and "other".

describe("repos", () => {
  it("getRepo returns the entry", () => {
    expect(getRepo("myrepo")?.localPath).toBe("/tmp/myrepo");
  });
  it("getRepo returns undefined for unknown", () => {
    expect(getRepo("nope")).toBeUndefined();
  });
  it("listRepoNames returns all names", () => {
    expect(listRepoNames().sort()).toEqual(["myrepo", "other"]);
  });
  it("buildPrUrl composes owner/repo/pull/N", () => {
    // adapt once the signature is confirmed; remove if buildPrUrl isn't exported
  });
});
```
Inspect `src/shared/repos.ts` first; drop the `buildPrUrl` block if it's not exported.

**Verify:** `npx vitest run src/shared/repos.test.ts`.

**Commit:** `test: cover repos registry accessors`

---

### Task 1.5: `shared/config.ts` env schema

**Files:**
- Create: `src/shared/config.test.ts`

**Implementation:**
Directly import the schema and exercise it without going through the `_env` singleton (so we can test failure cases).

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-parse envSchema by constructing a minimal env. We test the REGISTERED_REPOS
// transform and basic required-field rejection through the module's schema.
// Since envSchema isn't exported, we run loadEnv() with process.env overrides
// and capture via a fresh module import.

describe("REGISTERED_REPOS transform", () => {
  it("rejects invalid JSON", async () => {
    const prev = process.env.REGISTERED_REPOS;
    process.env.REGISTERED_REPOS = "{not json";
    const mod = await import("./config.js?invalid-json");
    expect(() => mod.loadEnv()).toThrow(/REGISTERED_REPOS/);
    process.env.REGISTERED_REPOS = prev;
  });

  it("rejects wrong shape", async () => {
    const prev = process.env.REGISTERED_REPOS;
    process.env.REGISTERED_REPOS = JSON.stringify({ r: { missingLocalPath: true } });
    const mod = await import("./config.js?wrong-shape");
    expect(() => mod.loadEnv()).toThrow(/REGISTERED_REPOS shape invalid/);
    process.env.REGISTERED_REPOS = prev;
  });

  it("accepts valid repos", async () => {
    const prev = process.env.REGISTERED_REPOS;
    process.env.REGISTERED_REPOS = JSON.stringify({
      r: { localPath: "/tmp/r", githubUrl: "https://github.com/a/b" },
    });
    const mod = await import("./config.js?valid");
    expect(mod.loadEnv().REGISTERED_REPOS.r.localPath).toBe("/tmp/r");
    process.env.REGISTERED_REPOS = prev;
  });
});
```

Note: `loadEnv` uses a module-level `_env` cache. To force re-parse per test, either (a) reset between tests by re-importing with a query suffix as shown, or (b) add a small test-only `resetEnvForTesting()` helper to `config.ts`. Option (b) is cleaner — prefer it:

In `src/shared/config.ts` add:
```ts
/** Test-only. Clears the cached env so the next `loadEnv()` re-parses. */
export function resetEnvForTesting(): void {
  _env = null;
}
```

Then the tests become:
```ts
import { loadEnv, resetEnvForTesting } from "./config.js";

beforeEach(() => resetEnvForTesting());
```

**Verify:** `npx vitest run src/shared/config.test.ts`.

**Commit:** `test: cover env schema and REGISTERED_REPOS transform`

---

### Task 1.6: `shared/events.ts` pub/sub

**Files:**
- Create: `src/shared/events.test.ts`

**Implementation:**
```ts
import { describe, it, expect, vi } from "vitest";
import { subscribe, emit } from "./events.js";

describe("events", () => {
  it("emit fans out to all subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    unsubA();
    unsubB();
  });

  it("unsubscribe stops further delivery", () => {
    const a = vi.fn();
    const unsub = subscribe(a);
    unsub();
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(a).not.toHaveBeenCalled();
  });

  it("throwing listener does not break siblings", () => {
    const thrower = vi.fn(() => { throw new Error("boom"); });
    const ok = vi.fn();
    const u1 = subscribe(thrower);
    const u2 = subscribe(ok);
    emit({ type: "task_update", taskId: "t", status: "running" });
    expect(ok).toHaveBeenCalledOnce();
    u1(); u2();
  });
});
```

**Verify:** `npx vitest run src/shared/events.test.ts`.

**Commit:** `test: cover shared event bus`

---

### Task 1.7: Dashboard `log-viewer/helpers.ts`

**Files:**
- Create: `dashboard/src/components/log-viewer/helpers.test.ts`

**Implementation:**
```ts
import { describe, it, expect } from "vitest";
import {
  visibleEntries,
  dedupeById,
  buildToolResultIndex,
  joinText,
} from "./helpers.js";
import type { FileEntry } from "@dashboard/lib/api";

const header = { type: "session", id: "s1", version: 3 } as unknown as FileEntry;
const userMsg = {
  type: "message",
  id: "m1",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
} as unknown as FileEntry;
const toolResult = {
  type: "message",
  id: "m2",
  message: { role: "toolResult", toolCallId: "tc1", content: [] },
} as unknown as FileEntry;

describe("visibleEntries", () => {
  it("drops session/model_change/etc, keeps messages", () => {
    const out = visibleEntries([header, userMsg]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("m1");
  });
});

describe("dedupeById", () => {
  it("preserves first-seen order and drops repeats", () => {
    const out = dedupeById([userMsg, userMsg, toolResult]);
    expect(out.map((e) => (e as any).id)).toEqual(["m1", "m2"]);
  });
});

describe("buildToolResultIndex", () => {
  it("maps toolCallId -> tool result entry", () => {
    const idx = buildToolResultIndex([userMsg, toolResult] as any);
    expect(idx.get("tc1")?.id).toBe("m2");
  });
});

describe("joinText", () => {
  it("concatenates text blocks, skips images", () => {
    const blocks = [
      { type: "text", text: "hello " },
      { type: "image", url: "x" },
      { type: "text", text: "world" },
    ];
    expect(joinText(blocks)).toBe("hello world");
  });
});
```

**Verify:** `npx vitest run dashboard/src/components/log-viewer/helpers.test.ts`.

**Commit:** `test: cover log-viewer pure helpers`

---

### Task 1.8: Dashboard `lib/format.ts`, `lib/task-grouping.ts`, `lib/utils.ts`

**Files:**
- Create: `dashboard/src/lib/format.test.ts`
- Create: `dashboard/src/lib/task-grouping.test.ts`
- Create: `dashboard/src/lib/utils.test.ts`

**Implementation:**
Read each source file first to confirm exported signatures. Typical shape:

`format.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo, formatDuration, formatTokens, formatTime } from "./format.js";

describe("format", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-04-21T12:00:00Z")));
  afterEach(() => vi.useRealTimers());

  it("timeAgo: seconds, minutes, hours, days", () => {
    expect(timeAgo(new Date("2026-04-21T11:59:30Z"))).toMatch(/30s|sec/);
    expect(timeAgo(new Date("2026-04-21T11:55:00Z"))).toMatch(/5m|min/);
    expect(timeAgo(new Date("2026-04-21T09:00:00Z"))).toMatch(/3h/);
    expect(timeAgo(new Date("2026-04-20T12:00:00Z"))).toMatch(/1d/);
  });

  it("formatDuration handles 0, seconds, minutes, hours", () => {
    expect(formatDuration(0)).toMatch(/0/);
    expect(formatDuration(45_000)).toMatch(/45s/);
    expect(formatDuration(65_000)).toMatch(/1m/);
  });

  it("formatTokens compacts thousands", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toMatch(/1\.5k|1k/);
  });
});
```

`task-grouping.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { groupTasks } from "./task-grouping.js"; // adjust export name

describe("groupTasks", () => {
  it("buckets into today / yesterday / this week / older", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-04-21T12:00:00Z"));
    const tasks = [
      { id: "1", createdAt: "2026-04-21T08:00:00Z" },
      { id: "2", createdAt: "2026-04-20T08:00:00Z" },
      { id: "3", createdAt: "2026-04-17T08:00:00Z" },
      { id: "4", createdAt: "2026-03-01T08:00:00Z" },
    ] as any[];
    const grouped = groupTasks(tasks);
    // assertions depend on actual shape; mirror the real buckets
    vi.useRealTimers();
  });
});
```

`utils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { cn, shortId } from "./utils.js";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", false, "b", null, "c")).toBe("a b c");
  });
});

describe("shortId", () => {
  it("returns first 8 chars", () => {
    expect(shortId("a1b2c3d4-5678-90ab-cdef-123456789012")).toBe("a1b2c3d4");
  });
});
```

**Verify:** `npx vitest run dashboard/src/lib/`.

**Commit:** `test: cover dashboard pure lib helpers`

---

## Phase 2 — IO adapters with mocked boundaries

### Task 2.1: `core/github.ts` gh CLI wrappers

**Files:**
- Create: `src/core/github.io.test.ts`
- Create: `tests/fixtures/gh/pr-view-comments.json`
- Create: `tests/fixtures/gh/pr-comments-api.json`
- Create: `tests/fixtures/gh/pr-view-state.json`

**Implementation:**
Capture real `gh` output into the fixtures (run against any real PR once). Shape example for `pr-view-comments.json`:
```json
{ "comments": [{ "id": "IC_1", "author": { "login": "alice" }, "body": "lgtm", "createdAt": "2026-04-20T00:00:00Z" }] }
```

Test:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { getPrComments, getPrReviewComments, isPrClosed } from "./github.js";

const mockedExec = vi.mocked(execFile);

function stubOk(stdout: string) {
  // promisify(execFile) awaits a callback-style function. Reproduce that.
  mockedExec.mockImplementation(((_cmd: any, _args: any, cb: any) => {
    cb(null, { stdout, stderr: "" });
  }) as any);
}
function stubThrow() {
  mockedExec.mockImplementation(((_cmd: any, _args: any, cb: any) => {
    cb(new Error("gh blew up"), { stdout: "", stderr: "" });
  }) as any);
}

beforeEach(() => mockedExec.mockReset());

describe("getPrComments", () => {
  it("returns parsed comments", async () => {
    stubOk(await readFile("tests/fixtures/gh/pr-view-comments.json", "utf-8"));
    const out = await getPrComments("foo/bar", 1);
    expect(out[0].author).toBe("alice");
  });
  it("returns [] on exec error", async () => {
    stubThrow();
    expect(await getPrComments("foo/bar", 1)).toEqual([]);
  });
  it("returns [] on malformed stdout", async () => {
    stubOk("not json");
    expect(await getPrComments("foo/bar", 1)).toEqual([]);
  });
});

describe("getPrReviewComments", () => {
  it("returns parsed review comments", async () => {
    stubOk(await readFile("tests/fixtures/gh/pr-comments-api.json", "utf-8"));
    const out = await getPrReviewComments("foo/bar", 1);
    expect(out[0]).toHaveProperty("path");
  });
  it("returns [] on error", async () => {
    stubThrow();
    expect(await getPrReviewComments("foo/bar", 1)).toEqual([]);
  });
});

describe("isPrClosed", () => {
  it("true when state is MERGED", async () => {
    stubOk(JSON.stringify({ state: "MERGED" }));
    expect(await isPrClosed("foo/bar", 1)).toBe(true);
  });
  it("false when state is OPEN", async () => {
    stubOk(JSON.stringify({ state: "OPEN" }));
    expect(await isPrClosed("foo/bar", 1)).toBe(false);
  });
  it("false on error", async () => {
    stubThrow();
    expect(await isPrClosed("foo/bar", 1)).toBe(false);
  });
});
```

**Verify:** `npx vitest run src/core/github.io.test.ts`.

**Commit:** `test: cover github gh-cli wrappers with mocked execFile`

---

### Task 2.2: `shared/llm.ts` via msw

**Files:**
- Create: `tests/setup/msw.ts`
- Create: `src/shared/llm.test.ts`

**Implementation:**

`tests/setup/msw.ts`:
```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

export const server = setupServer();

export function mockFireworksResponse(content: string | null, status = 200) {
  server.use(
    http.post(FIREWORKS_URL, () => {
      if (status !== 200) return new HttpResponse("upstream error", { status });
      return HttpResponse.json({ choices: [{ message: { content } }] });
    }),
  );
}

export function mockFireworksNetworkError() {
  server.use(http.post(FIREWORKS_URL, () => HttpResponse.error()));
}
```

Register lifecycle in a shared `tests/setup/msw-lifecycle.ts` or append directly in llm test:
```ts
import { beforeAll, afterAll, afterEach } from "vitest";
import { server } from "../../tests/setup/msw.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

`src/shared/llm.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { z } from "zod";
import { server, mockFireworksResponse, mockFireworksNetworkError } from "../../tests/setup/msw.js";
import { complete, structuredOutput } from "./llm.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("complete", () => {
  it("returns content on 200", async () => {
    mockFireworksResponse("hello");
    expect(await complete("hi")).toBe("hello");
  });
  it("returns null on non-2xx", async () => {
    mockFireworksResponse(null, 500);
    expect(await complete("hi")).toBeNull();
  });
  it("returns null on network error", async () => {
    mockFireworksNetworkError();
    expect(await complete("hi")).toBeNull();
  });
});

describe("structuredOutput", () => {
  const schema = z.object({ kind: z.literal("ok"), value: z.number() });

  it("returns typed object on valid JSON", async () => {
    mockFireworksResponse(JSON.stringify({ kind: "ok", value: 42 }));
    const out = await structuredOutput({ system: "s", prompt: "p", schema });
    expect(out.value).toBe(42);
  });
  it("throws on invalid JSON", async () => {
    mockFireworksResponse("not json");
    await expect(structuredOutput({ system: "s", prompt: "p", schema })).rejects.toThrow(/invalid JSON/);
  });
  it("throws on schema mismatch", async () => {
    mockFireworksResponse(JSON.stringify({ kind: "wrong" }));
    await expect(structuredOutput({ system: "s", prompt: "p", schema })).rejects.toThrow(/schema validation/);
  });
  it("throws on empty body", async () => {
    mockFireworksResponse(null);
    await expect(structuredOutput({ system: "s", prompt: "p", schema })).rejects.toThrow(/empty response/);
  });
});
```

**Verify:** `npx vitest run src/shared/llm.test.ts`.

**Commit:** `test: cover llm client with msw-mocked fireworks api`

---

### Task 2.3: `telegram/intent-classifier.ts`

**Files:**
- Create: `src/telegram/intent-classifier.test.ts`

**Implementation:**
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shared/llm.js", () => ({
  LIGHT_MODEL: "light",
  structuredOutput: vi.fn(),
}));

import { structuredOutput } from "../shared/llm.js";
import { classifyMessage } from "./intent-classifier.js";

const mocked = vi.mocked(structuredOutput);

beforeEach(() => mocked.mockReset());

describe("classifyMessage", () => {
  it("returns coding_task intent", async () => {
    mocked.mockResolvedValue({ type: "coding_task", repo: "myrepo", description: "do x" } as any);
    const intent = await classifyMessage("myrepo do x", ["myrepo"]);
    expect(intent.type).toBe("coding_task");
  });

  it("falls back to unknown on LLM throw", async () => {
    mocked.mockRejectedValue(new Error("boom"));
    const intent = await classifyMessage("hi", ["myrepo"]);
    expect(intent).toEqual({ type: "unknown", rawText: "hi" });
  });

  it.each([
    ["pr_review",         { type: "pr_review", repo: "myrepo", prIdentifier: "#42" }],
    ["codebase_question", { type: "codebase_question", repo: "myrepo", question: "q" }],
    ["task_status",       { type: "task_status" }],
    ["task_cancel",       { type: "task_cancel", taskPrefix: "abcd1234" }],
    ["task_retry",        { type: "task_retry", taskPrefix: "abcd1234" }],
  ])("routes %s through schema unchanged", async (_label, payload) => {
    mocked.mockResolvedValue(payload as any);
    const intent = await classifyMessage("msg", ["myrepo"]);
    expect(intent.type).toBe((payload as any).type);
  });
});
```

**Verify:** `npx vitest run src/telegram/intent-classifier.test.ts`.

**Commit:** `test: cover intent classifier fallbacks and routing`

---

### Task 2.4: `telegram/handlers.ts` — the high-value one

**Files:**
- Create: `src/telegram/handlers.test.ts`

**Implementation:**
Read `src/telegram/handlers.ts` in full first so mock surfaces match what it actually calls. Then:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pipelines/coding/pipeline.js",   () => ({ runPipeline: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../pipelines/question/pipeline.js", () => ({ runQuestion: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../pipelines/pr-review/pipeline.js",() => ({ runPrReview: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../core/stage.js",                  () => ({ cancelTask: vi.fn() }));
vi.mock("../db/queries.js",                  () => ({
  createTask:    vi.fn(async (data: any) => ({ id: "task-1234-5678", ...data })),
  listTasks:     vi.fn(async () => []),
  getTask:       vi.fn(),
  updateTask:    vi.fn(),
}));

import { runPipeline } from "../pipelines/coding/pipeline.js";
import { runQuestion } from "../pipelines/question/pipeline.js";
import { cancelTask } from "../core/stage.js";
import * as queries from "../db/queries.js";
import { handleIntent } from "./handlers.js";

function makeCtx() {
  return {
    chatId: "1",
    sendTelegram: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.mocked(runPipeline).mockClear();
  vi.mocked(runQuestion).mockClear();
  vi.mocked(cancelTask).mockClear();
  vi.mocked(queries.createTask).mockClear();
  vi.mocked(queries.listTasks).mockClear();
  vi.mocked(queries.getTask).mockClear();
});

describe("handleIntent", () => {
  it("coding_task creates task and starts pipeline", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "coding_task", repo: "myrepo", description: "add dark mode" },
      ctx,
    );
    expect(queries.createTask).toHaveBeenCalledOnce();
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("unknown repo replies with repo list and does not start pipeline", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "coding_task", repo: "nope", description: "x" },
      ctx,
    );
    expect(runPipeline).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("codebase_question routes to runQuestion", async () => {
    const ctx = makeCtx();
    await handleIntent(
      { type: "codebase_question", repo: "myrepo", question: "what does X do" },
      ctx,
    );
    expect(runQuestion).toHaveBeenCalledOnce();
  });

  it("pr_review replies 'not implemented yet'", async () => {
    const ctx = makeCtx();
    await handleIntent({ type: "pr_review", repo: "myrepo", prIdentifier: "#1" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not implemented"));
  });

  it("task_cancel on running task calls cancelTask", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([
      { id: "abcd1234-...", status: "running", repo: "myrepo" } as any,
    ]);
    vi.mocked(cancelTask).mockReturnValueOnce(true);
    const ctx = makeCtx();
    await handleIntent({ type: "task_cancel", taskPrefix: "abcd1234" }, ctx);
    expect(cancelTask).toHaveBeenCalledWith("abcd1234-...");
  });

  it("task_cancel on terminal task replies with error", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([
      { id: "abcd1234-...", status: "complete", repo: "myrepo" } as any,
    ]);
    const ctx = makeCtx();
    await handleIntent({ type: "task_cancel", taskPrefix: "abcd1234" }, ctx);
    expect(cancelTask).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining(/cannot|not running|already/i.source));
  });

  it("task_retry on failed task starts pipeline", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([
      { id: "abcd1234-...", status: "failed", repo: "myrepo", kind: "coding_task" } as any,
    ]);
    const ctx = makeCtx();
    await handleIntent({ type: "task_retry", taskPrefix: "abcd1234" }, ctx);
    expect(runPipeline).toHaveBeenCalled();
  });

  it("task_retry on running task replies with error", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([
      { id: "abcd1234-...", status: "running", repo: "myrepo" } as any,
    ]);
    const ctx = makeCtx();
    await handleIntent({ type: "task_retry", taskPrefix: "abcd1234" }, ctx);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("task_status with no prefix lists tasks", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([]);
    const ctx = makeCtx();
    await handleIntent({ type: "task_status" }, ctx);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("ambiguous task prefix replies with error", async () => {
    vi.mocked(queries.listTasks).mockResolvedValueOnce([
      { id: "abcd1234-aaa", status: "complete", repo: "r" } as any,
      { id: "abcd1234-bbb", status: "complete", repo: "r" } as any,
    ]);
    const ctx = makeCtx();
    await handleIntent({ type: "task_cancel", taskPrefix: "abcd1234" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/ambiguous|multiple/i));
  });

  it("unknown intent replies with fallback message", async () => {
    const ctx = makeCtx();
    await handleIntent({ type: "unknown", rawText: "hi" }, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("didn't understand"));
  });
});
```

Exact reply-string assertions may need tweaking once the real messages are visible in `handlers.ts`.

**Verify:** `npx vitest run src/telegram/handlers.test.ts`.

**Commit:** `test: cover telegram intent dispatch paths`

---

### Task 2.5: `core/session-file.ts#watchSessionFile`

**Files:**
- Create: `src/core/session-file.watch.test.ts`

**Implementation:**
Real IO against `os.tmpdir()` with fake timers to drive the 500ms poll.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchSessionFile } from "./session-file.js";

function entryLine(id: string) {
  return JSON.stringify({ type: "message", id, message: { role: "user", content: [] } }) + "\n";
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function flushPoll() {
  await vi.advanceTimersByTimeAsync(600);
}

describe("watchSessionFile", () => {
  it("waits for file creation then emits appended lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "watch-"));
    const file = path.join(dir, "s.jsonl");
    const seen: any[] = [];
    const stop = watchSessionFile(file, (e) => seen.push(e));

    await flushPoll(); // file missing, no emissions
    expect(seen).toHaveLength(0);

    await writeFile(file, entryLine("m1"));
    await flushPoll();
    expect(seen).toHaveLength(1);

    await appendFile(file, entryLine("m2"));
    await flushPoll();
    expect(seen).toHaveLength(2);

    stop();
  });

  it("buffers partial lines until newline arrives", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "watch-"));
    const file = path.join(dir, "s.jsonl");
    const seen: any[] = [];
    const stop = watchSessionFile(file, (e) => seen.push(e));

    await writeFile(file, '{"type":"message","id":"m1","message":{"role":"user","content":[]}'); // no newline
    await flushPoll();
    expect(seen).toHaveLength(0);

    await appendFile(file, "}\n");
    await flushPoll();
    expect(seen).toHaveLength(1);

    stop();
  });

  it("restarts from offset 0 on truncate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "watch-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, entryLine("m1") + entryLine("m2"));
    const seen: any[] = [];
    const stop = watchSessionFile(file, (e) => seen.push(e));
    await flushPoll();
    expect(seen).toHaveLength(2);

    await writeFile(file, entryLine("new")); // truncate + rewrite
    await flushPoll();
    expect(seen).toHaveLength(3);
    expect(seen[2].id).toBe("new");

    stop();
  });

  it("disposer stops further callbacks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "watch-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, entryLine("m1"));
    const seen: any[] = [];
    const stop = watchSessionFile(file, (e) => seen.push(e));
    await flushPoll();
    stop();

    await appendFile(file, entryLine("m2"));
    await flushPoll();
    expect(seen).toHaveLength(1);
  });
});
```

**Verify:** `npx vitest run src/core/session-file.watch.test.ts`.

**Commit:** `test: cover watchSessionFile tail behavior`

---

### Task 2.6: `pipelines/cleanup.ts`

**Files:**
- Create: `src/pipelines/cleanup.test.ts`

**Implementation:**
Read `src/pipelines/cleanup.ts` entry points in full first. Mock every side effect:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../core/worktree.js", () => ({ removeWorktree: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../db/queries.js", () => ({
  getTask:                    vi.fn(),
  updateTask:                 vi.fn().mockResolvedValue(undefined),
  getPrSessionByOriginTask:   vi.fn().mockResolvedValue(null),
  updatePrSession:            vi.fn().mockResolvedValue(undefined),
}));

import { execFile } from "node:child_process";
import * as queries from "../db/queries.js";
import { removeWorktree } from "../core/worktree.js";
import { dismissTask } from "./cleanup.js";

function stubExecOk() {
  vi.mocked(execFile).mockImplementation(((_c: any, _a: any, cb: any) => cb(null, { stdout: "", stderr: "" })) as any);
}

beforeEach(() => {
  vi.mocked(queries.getTask).mockReset();
  vi.mocked(queries.updateTask).mockReset();
  vi.mocked(queries.getPrSessionByOriginTask).mockReset().mockResolvedValue(null);
  vi.mocked(removeWorktree).mockReset().mockResolvedValue(undefined);
  vi.mocked(execFile).mockReset();
  stubExecOk();
});

describe("dismissTask", () => {
  it("throws on running task", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce({
      id: "t1", repo: "myrepo", status: "running",
    } as any);
    await expect(dismissTask("t1")).rejects.toThrow(/cancel it first/);
  });

  it("closes PR + removes worktree + marks cancelled", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce({
      id: "t1", repo: "myrepo", status: "complete",
      prNumber: 42, worktreePath: "/tmp/wt", branch: "goodboy/x",
    } as any);

    await dismissTask("t1");

    expect(execFile).toHaveBeenCalled(); // gh pr close
    expect(removeWorktree).toHaveBeenCalled();
    expect(queries.updateTask).toHaveBeenCalledWith("t1", expect.objectContaining({ status: "cancelled" }));
  });

  it("delegates to PR-session cleanup when one exists", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce({
      id: "t1", repo: "myrepo", status: "complete",
    } as any);
    vi.mocked(queries.getPrSessionByOriginTask).mockResolvedValueOnce({
      id: "ps1", worktreePath: "/tmp/wt",
    } as any);

    await dismissTask("t1");

    // Direct cleanupGitResources branch should NOT be taken.
    // PR-session cleanup branch does its own removeWorktree.
    expect(removeWorktree).toHaveBeenCalled();
  });
});
```

Add more cases (`cleanupAfterMerge`, `cleanupPrSession`) once the exact signatures are confirmed from the source.

**Verify:** `npx vitest run src/pipelines/cleanup.test.ts`.

**Commit:** `test: cover cleanup entry points with mocked io`

---

## Phase 3 — HTTP + SSE routes

### Task 3.1: API integration test harness + fixture artifacts

**Files:**
- Create: `tests/integration/api.test.ts`

**Implementation:**
Top of file — hoisted mocks:

```ts
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import path from "node:path";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

// Mock DB + pipelines + cleanup so the API runs standalone.
vi.mock("../../src/db/queries.js", () => ({
  listTasks:                  vi.fn(),
  getTask:                    vi.fn(),
  getStagesForTask:           vi.fn().mockResolvedValue([]),
  listTasksWithPrs:           vi.fn().mockResolvedValue([]),
  listPrSessions:             vi.fn().mockResolvedValue([]),
  getPrSession:               vi.fn(),
  getRunsForPrSession:        vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/pipelines/coding/pipeline.js",    () => ({ runPipeline: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/pipelines/question/pipeline.js",  () => ({ runQuestion: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/pipelines/pr-review/pipeline.js", () => ({ runPrReview: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/pipelines/cleanup.js",            () => ({ dismissTask: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/core/stage.js",                   () => ({ cancelTask: vi.fn().mockReturnValue(true) }));

// Redirect config.artifactsDir into a per-run temp dir.
const TMP_ARTIFACTS = await mkdtemp(path.join(tmpdir(), "artifacts-"));
vi.mock("../../src/shared/config.js", async (orig) => {
  const mod = await orig<typeof import("../../src/shared/config.js")>();
  return {
    ...mod,
    config: { ...mod.config, artifactsDir: TMP_ARTIFACTS, prSessionsDir: path.join(TMP_ARTIFACTS, "pr-sessions") },
  };
});

import * as queries from "../../src/db/queries.js";
import { runPipeline } from "../../src/pipelines/coding/pipeline.js";
import { cancelTask } from "../../src/core/stage.js";
import { dismissTask } from "../../src/pipelines/cleanup.js";
import { createApi } from "../../src/api/index.js";
import { testClient } from "hono/testing";
```

Then the suite:

```ts
const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function fakeTask(overrides: Partial<any> = {}) {
  return {
    id: UUID, repo: "myrepo", kind: "coding_task", status: "complete",
    description: "x", chatId: "1", instance: "test",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    prNumber: null, prUrl: null, worktreePath: null, branch: null, error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(queries.listTasks).mockReset().mockResolvedValue([fakeTask()]);
  vi.mocked(queries.getTask).mockReset();
  vi.mocked(runPipeline).mockClear();
  vi.mocked(cancelTask).mockClear();
  vi.mocked(dismissTask).mockClear();
});

describe("GET /api/tasks", () => {
  it("returns all tasks", async () => {
    const client = testClient(createApi());
    const res = await client.api.tasks.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("passes status filter to queries.listTasks", async () => {
    const client = testClient(createApi());
    await client.api.tasks.$get({ query: { status: "running" } });
    expect(queries.listTasks).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
  });

  it("rejects invalid status with 400", async () => {
    const client = testClient(createApi());
    const res = await client.api.tasks.$get({ query: { status: "bogus" as any } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 when missing", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce(null);
    const client = testClient(createApi());
    const res = await client.api.tasks[":id"].$get({ param: { id: UUID } });
    expect(res.status).toBe(404);
  });

  it("returns task with stages when found", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce(fakeTask() as any);
    const client = testClient(createApi());
    const res = await client.api.tasks[":id"].$get({ param: { id: UUID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stages");
  });
});

describe("GET /api/tasks/:id/artifacts/:name — path traversal defense", () => {
  beforeAll(async () => {
    await mkdir(path.join(TMP_ARTIFACTS, UUID), { recursive: true });
    await writeFile(path.join(TMP_ARTIFACTS, UUID, "plan.md"), "# hello");
  });

  it("returns 200 for valid path", async () => {
    const res = await fetch(`http://x/api/tasks/${UUID}/artifacts/plan.md`, {
      // routing via raw fetch-like call using app.fetch:
    } as any).catch(() => null);
    // If testClient's typing makes this awkward, use createApi().fetch(new Request(...))
    // See "raw fetch" helper below.
  });

  it.each([
    ["not-a-uuid", "plan.md"],
    [UUID,         "../../etc/passwd"],
    [UUID,         ".env"],
  ])("returns 404 for %s / %s", async (id, name) => {
    const app = createApi();
    const res = await app.fetch(new Request(`http://x/api/tasks/${id}/artifacts/${name}`));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("calls the coding pipeline for a coding task", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce(fakeTask({ status: "failed", kind: "coding_task" }) as any);
    const app = createApi();
    const res = await app.fetch(new Request(`http://x/api/tasks/${UUID}/retry`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(runPipeline).toHaveBeenCalledWith(UUID, expect.any(Function));
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("calls cancelTask", async () => {
    vi.mocked(queries.getTask).mockResolvedValueOnce(fakeTask({ status: "running" }) as any);
    const app = createApi();
    const res = await app.fetch(new Request(`http://x/api/tasks/${UUID}/cancel`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(cancelTask).toHaveBeenCalledWith(UUID);
  });
});

describe("GET /api/repos, /api/prs", () => {
  it("repos returns the registered list", async () => {
    const app = createApi();
    const res = await app.fetch(new Request("http://x/api/repos"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toBeInstanceOf(Array);
  });
  it("prs returns list shape", async () => {
    const app = createApi();
    const res = await app.fetch(new Request("http://x/api/prs"));
    expect(res.status).toBe(200);
  });
});
```

Notes while implementing:
- Prefer raw `app.fetch(new Request(...))` calls everywhere over `testClient` — keeps the test file simple and avoids Hono's typed-client edge cases. Drop the `testClient` import if unused.
- Route paths (`/api/tasks` vs `/tasks`) must match what `createApi()` actually registers — confirm by reading `src/api/index.ts` once.

**Verify:** `npx vitest run tests/integration/api.test.ts`.

**Commit:** `test: cover api routes with mocked db and pipelines`

---

### Task 3.2: SSE stream test

**Files:**
- Create: `tests/integration/api.sse.test.ts`

**Implementation:**
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/queries.js", () => ({})); // SSE route doesn't touch DB; stub anyway
vi.mock("../../src/pipelines/coding/pipeline.js",    () => ({ runPipeline: vi.fn() }));
vi.mock("../../src/pipelines/question/pipeline.js",  () => ({ runQuestion: vi.fn() }));
vi.mock("../../src/pipelines/pr-review/pipeline.js", () => ({ runPrReview: vi.fn() }));
vi.mock("../../src/pipelines/cleanup.js",            () => ({ dismissTask: vi.fn() }));
vi.mock("../../src/core/stage.js",                   () => ({ cancelTask: vi.fn() }));

import { createApi } from "../../src/api/index.js";
import { emit } from "../../src/shared/events.js";

async function readFrames(stream: ReadableStream<Uint8Array>, count: number, timeoutMs = 2000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ event?: string; data?: string }> = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const event = f.match(/^event:\s*(.+)$/m)?.[1];
      const data  = f.match(/^data:\s*(.*)$/m)?.[1];
      events.push({ event, data });
    }
  }
  reader.releaseLock();
  return events;
}

describe("GET /api/events SSE", () => {
  it("delivers emitted events to subscribers", async () => {
    const app = createApi();
    const res = await app.fetch(new Request("http://x/api/events", {
      headers: { accept: "text/event-stream" },
    }));
    expect(res.headers.get("content-type")).toMatch(/event-stream/);
    expect(res.body).toBeTruthy();

    // Give Hono a tick to install the subscriber.
    await new Promise((r) => setTimeout(r, 50));
    emit({ type: "task_update", taskId: "t1", status: "running" });

    const frames = await readFrames(res.body!, 1);
    const taskUpdate = frames.find((f) => f.event === "task_update");
    expect(taskUpdate).toBeTruthy();
    expect(taskUpdate!.data).toContain("t1");
  });
});
```

**Verify:** `npx vitest run tests/integration/api.sse.test.ts`.

**Commit:** `test: cover sse event stream`

---

## Final task: green-light the suite

### Task 4.1: Run the full suite + fix drift

**Files:**
- None (verification only)

**Implementation:**
```bash
npm run build
npm test
npm run test:cov   # optional, eyeball coverage
```

Triage any failures. Most likely causes:
- Mock surface drift — a mocked module export is out of date vs the real one. Fix by adding the missing name to the `vi.mock()` return object.
- Route path mismatch — `testClient` / `app.fetch` URL doesn't line up with actual Hono registration. Read `src/api/index.ts` and correct.
- Env-var ordering — `tests/setup/env.ts` must run before any module imports `loadEnv()`. If a test fails with `REGISTERED_REPOS` errors, verify `setupFiles` is wired in `vitest.config.ts`.

**Verify:** `npm test` exits 0. CI-equivalent command `npm run build && npm test` exits 0.

**Commit:** `chore: ship first test suite (unit + api integration)`

---

## Sequencing + PRs

Three PRs, each green on its own:

| PR | Tasks | Approximate effort |
|---|---|---|
| **PR 1: Vitest scaffold + pure-function tests** | 0.1–0.4, 1.1–1.8 | 4 hr |
| **PR 2: IO adapters** | 2.1–2.6 | 1 day |
| **PR 3: API + SSE** | 3.1, 3.2, 4.1 | 1 day |

Total: ~2.5 focused days.

---

Plan ready. Want me to start executing now, or do you want to review first?