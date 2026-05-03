/**
 * pi extension exposing controlled code reviewer feedback memory mutations.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import {
  appendCodeReviewerFeedback,
  listCodeReviewerFeedback,
  updateCodeReviewerFeedback,
} from "../core/memory/code-reviewer-feedback.js";

const scopeSchema = Type.Union([
  Type.Object({ type: Type.Literal("global") }),
  Type.Object({ type: Type.Literal("path"), paths: Type.Array(Type.String()) }),
  Type.Object({ type: Type.Literal("review_behavior") }),
]);

const sourceSchema = Type.Object({
  type: StringEnum(["github_comment", "dashboard_chat"] as const),
  prNumber: Type.Number(),
  originalText: Type.String(),
});

const paramsSchema = Type.Object({
  action: StringEnum(["list", "append", "update"] as const),
  repo: Type.String(),
  status: Type.Optional(StringEnum(["active", "inactive", "all"] as const)),
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  rule: Type.Optional(Type.String()),
  scope: Type.Optional(scopeSchema),
  source: Type.Optional(sourceSchema),
});

type CodeReviewerFeedbackParams = Static<typeof paramsSchema>;

export default function codeReviewerFeedbackExtension(pi: ExtensionAPI): void {
  pi.registerTool<typeof paramsSchema, unknown>({
    name: "code_reviewer_feedback",
    label: "Code Reviewer Feedback",
    description: "List, append, or update durable code reviewer feedback rules for a registered repo.",
    promptSnippet: "List, append, or update durable code reviewer feedback rules.",
    promptGuidelines: [
      "Use code_reviewer_feedback only for durable human feedback about future PR review or PR code mutation behavior.",
      "Do not create duplicate active code_reviewer_feedback rules; list existing rules first when unsure.",
      "When feedback replaces an old rule, call code_reviewer_feedback with action update to mark the old rule inactive, then append a new active rule.",
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, params: CodeReviewerFeedbackParams) {
      if (params.action === "list") {
        const rules = await listCodeReviewerFeedback(params.repo, params.status ?? "active");
        return {
          content: [{ type: "text", text: JSON.stringify(rules, null, 2) }],
          details: { rules },
        };
      }

      if (params.action === "append") {
        if (!params.title || !params.rule || !params.scope || !params.source) {
          throw new Error("append requires title, rule, scope, and source");
        }
        const appended = await appendCodeReviewerFeedback({
          repo: params.repo,
          title: params.title,
          rule: params.rule,
          scope: params.scope,
          source: params.source,
        });
        return {
          content: [{ type: "text", text: `Appended ${appended.id}: ${appended.title}` }],
          details: { rule: appended },
        };
      }

      if (!params.id) throw new Error("update requires id");
      const updated = await updateCodeReviewerFeedback({
        repo: params.repo,
        id: params.id,
        status: params.status === "active" || params.status === "inactive" ? params.status : undefined,
        title: params.title,
        rule: params.rule,
        scope: params.scope,
      });
      return {
        content: [{ type: "text", text: `Updated ${updated.id}: ${updated.title}` }],
        details: { rule: updated },
      };
    },
  });
}
