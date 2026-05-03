import { describe, expect, it } from "vitest";
import {
  formatReviewChatPrompt,
  parseReviewChatResult,
  reviewChatSystemPrompt,
  extractReviewChatMessages,
  latestAssistantText,
  stripResultMarker,
} from "@src/pipelines/pr-session/review-chat/index.js";
import type { PrReviewAnnotation } from "@src/shared/contracts/pr-review.js";
import type { FileEntry } from "@src/shared/contracts/session.js";

const artifacts = {
  reviewPath: "/a/review.json",
  summaryPath: "/a/summary.md",
  diffPath: "/a/pr.diff",
  updatedDiffPath: "/a/pr.updated.diff",
  contextPath: "/a/pr-context.json",
  updatedContextPath: "/a/pr-context.updated.json",
  reportsDir: "/a/reports",
};

const annotation: PrReviewAnnotation = {
  filePath: "src/checkoutMachine.ts",
  side: "new",
  line: 42,
  kind: "concern",
  title: "Migration drops v2 sessions",
  body: "Hydrating saved state from before this PR throws unknown_state.",
};

describe("reviewChatSystemPrompt", () => {
  const prompt = reviewChatSystemPrompt({ repo: "acme/widgets", branch: "feat/x", prNumber: 7 });

  it("references the repo, branch, and PR number", () => {
    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("feat/x");
    expect(prompt).toContain("PR #7");
  });

  it("requires commit + push after edits and forbids GitHub posts", () => {
    expect(prompt).toMatch(/commit.*push/i);
    expect(prompt).toMatch(/Never force-push/i);
    expect(prompt).toMatch(/(do not|don't) post GitHub/i);
  });

  it("locks in the JSON marker contract", () => {
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toContain('"status":"complete"');
    expect(prompt).toContain('"changed"');
  });

  it("frames the agent as a friendly review companion, not a curt SMS bot", () => {
    expect(prompt).toMatch(/friendly|helpful/i);
    expect(prompt).not.toMatch(/5-10 word/);
    expect(prompt).not.toMatch(/texting-style/i);
  });
});

describe("formatReviewChatPrompt", () => {
  it("includes the user message, active file, and artifact paths", () => {
    const out = formatReviewChatPrompt({
      context: { message: "Why does this regress hydration?", activeFile: "src/a.ts", annotation: null },
      artifacts,
    });
    expect(out).toContain("USER MESSAGE:");
    expect(out).toContain("Why does this regress hydration?");
    expect(out).toContain("ACTIVE FILE: src/a.ts");
    expect(out).toContain(artifacts.reviewPath);
    expect(out).toContain(artifacts.summaryPath);
    expect(out).toContain(artifacts.updatedDiffPath);
    expect(out).not.toContain("REPLYING TO ANNOTATION:");
  });

  it("renders the annotation block when one is attached", () => {
    const out = formatReviewChatPrompt({
      context: { message: "Fix this.", activeFile: annotation.filePath, annotation },
      artifacts,
    });
    expect(out).toContain("REPLYING TO ANNOTATION:");
    expect(out).toContain(annotation.title);
    expect(out).toContain(annotation.body);
    expect(out).toContain(`${annotation.filePath}:+${annotation.line}`);
  });

  it("marks the active file as none when omitted", () => {
    const out = formatReviewChatPrompt({
      context: { message: "broad q", activeFile: null, annotation: null },
      artifacts,
    });
    expect(out).toContain("ACTIVE FILE: (none)");
  });
});

describe("parseReviewChatResult", () => {
  it("parses a valid trailing marker", () => {
    const text = `Looked into it.\n\n{"status":"complete","changed":true}`;
    expect(parseReviewChatResult(text)).toEqual({ status: "complete", changed: true });
  });

  it("returns the last valid marker when multiple JSON-ish blocks appear", () => {
    const text = `prelude {"foo":1} body\n{"status":"complete","changed":false}`;
    expect(parseReviewChatResult(text)).toEqual({ status: "complete", changed: false });
  });

  it("returns null for malformed markers", () => {
    expect(parseReviewChatResult("no json here")).toBeNull();
    expect(parseReviewChatResult('{"status":"weird","changed":true}')).toBeNull();
    expect(parseReviewChatResult('{"status":"complete"}')).toBeNull();
  });

  it("accepts a failed marker", () => {
    const text = `nope.\n{"status":"failed","changed":false}`;
    expect(parseReviewChatResult(text)).toEqual({ status: "failed", changed: false });
  });
});

describe("extractReviewChatMessages", () => {
  function userEntry(id: string, text: string): FileEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-04-30T12:00:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 0,
      },
    };
  }

  function assistantEntry(id: string, text: string): FileEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-04-30T12:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    };
  }

  it("pairs each review_chat user prompt with the assistant text minus the marker", () => {
    const userPrompt = formatReviewChatPrompt({
      context: { message: "Explain the rename.", activeFile: "src/a.ts", annotation: null },
      artifacts,
    });
    const reply = `Yes -- it's intentional. The new name better reflects the contract.\n{"status":"complete","changed":false}`;
    const entries: FileEntry[] = [userEntry("u1", userPrompt), assistantEntry("a1", reply)];

    const messages = extractReviewChatMessages(entries);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts).toEqual([{ type: "text", text: "Explain the rename." }]);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toEqual([
      { type: "text", text: "Yes -- it's intentional. The new name better reflects the contract." },
    ]);
  });

  it("skips user prompts that are not review_chat (e.g. comment turns)", () => {
    const entries: FileEntry[] = [
      userEntry("u1", "New comments on your PR: ..."),
      assistantEntry("a1", `done.\n{"status":"complete","changed":false}`),
    ];
    expect(extractReviewChatMessages(entries)).toEqual([]);
  });

  it("stripResultMarker removes the trailing JSON marker but keeps prose intact", () => {
    const text = `Here's what I found:\n\n- line 42 catches 429 without retry\n- this drops trades silently under load\n\n{"status":"complete","changed":false}`;
    expect(stripResultMarker(text)).toBe(
      `Here's what I found:\n\n- line 42 catches 429 without retry\n- this drops trades silently under load`,
    );
  });

  it("stripResultMarker leaves text alone when there is no marker", () => {
    const text = "just prose, no json here";
    expect(stripResultMarker(text)).toBe(text);
  });

  it("latestAssistantText returns the most recent assistant text", () => {
    const entries: FileEntry[] = [
      assistantEntry("a1", "first reply"),
      userEntry("u1", "new question"),
      assistantEntry("a2", "latest reply"),
    ];
    expect(latestAssistantText(entries)).toBe("latest reply");
    expect(latestAssistantText([])).toBeNull();
  });

  it("preserves the annotation attachment on the user side", () => {
    const userPrompt = formatReviewChatPrompt({
      context: { message: "Fix this.", activeFile: annotation.filePath, annotation },
      artifacts,
    });
    const reply = `done.\n{"status":"complete","changed":true}`;
    const entries: FileEntry[] = [userEntry("u1", userPrompt), assistantEntry("a1", reply)];

    const [user] = extractReviewChatMessages(entries);
    const annotationPart = user.parts.find((p) => p.type === "annotation");
    expect(annotationPart).toBeTruthy();
    if (annotationPart && annotationPart.type === "annotation") {
      expect(annotationPart.annotation.filePath).toBe(annotation.filePath);
      expect(annotationPart.annotation.line).toBe(annotation.line);
      expect(annotationPart.annotation.kind).toBe(annotation.kind);
    }
  });
});
