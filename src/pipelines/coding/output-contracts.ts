/**
 * Output contracts for the coding pipeline.
 * Stages resolve these once and share them across prompts and validation.
 */

import { defineTextOutput } from "../../shared/agent-output/contracts.js";

export const codingOutputs = {
  plan: defineTextOutput({
    id: "coding.plan",
    path: () => "plan.md",
    prompt: { name: "implementation plan", instructions: "Write the complete implementation plan here." },
    dashboard: () => ({ key: "plan.md", label: "plan" }),
  }),
  implementationSummary: defineTextOutput({
    id: "coding.implementationSummary",
    path: () => "implementation-summary.md",
    prompt: { name: "implementation summary", instructions: "Write the final implementation summary here." },
    dashboard: () => ({ key: "implementation-summary.md", label: "summary" }),
  }),
  review: defineTextOutput({
    id: "coding.review",
    path: () => "review.md",
    prompt: { name: "implementation review", instructions: "Write the final self-review here." },
    dashboard: () => ({ key: "review.md", label: "review" }),
  }),
};

export function codingStageOutput(stage: "planner" | "implementer" | "reviewer") {
  switch (stage) {
    case "planner":
      return codingOutputs.plan;
    case "implementer":
      return codingOutputs.implementationSummary;
    case "reviewer":
      return codingOutputs.review;
  }
}
