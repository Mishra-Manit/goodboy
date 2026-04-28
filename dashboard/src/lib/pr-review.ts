/** Pure display helpers for PR review tasks and PR sessions. */

import { Eye, MessageSquare } from "lucide-react";
import type { PrSessionMode, Task } from "@dashboard/lib/api";

// --- PR session presentation ---

/** Icon component for a PR session row, picked by mode. */
export function prSessionIcon(mode: PrSessionMode) {
  return mode === "own" ? MessageSquare : Eye;
}

/** Accessible label paired with `prSessionIcon`. */
export function prSessionIconTitle(mode: PrSessionMode): string {
  return mode === "own" ? "Own PR" : "External review";
}

// --- pr_review task display ---

const PR_URL_PREFIX = "http://";
const PR_URL_PREFIX_SECURE = "https://";

/** Best-effort external PR URL for a PR review task. */
export function getPrReviewUrl(task: Pick<Task, "kind" | "prIdentifier" | "description">): string | null {
  if (task.kind !== "pr_review") return null;
  const value = task.prIdentifier ?? task.description;
  if (!value) return null;
  if (value.startsWith(PR_URL_PREFIX) || value.startsWith(PR_URL_PREFIX_SECURE)) return value;
  return null;
}

/** Human-friendly PR target label for list/detail UIs. */
export function getPrReviewTarget(task: Pick<Task, "kind" | "prIdentifier" | "description" | "prNumber">): string {
  if (task.kind !== "pr_review") return task.description;
  if (task.prNumber) return `PR #${task.prNumber}`;

  const value = task.prIdentifier ?? task.description;
  if (!value) return "PR";

  const pullMatch = value.match(/\/pull\/(\d+)/);
  if (pullMatch) return `PR #${pullMatch[1]}`;

  const numberMatch = value.match(/^#?(\d+)$/);
  if (numberMatch) return `PR #${numberMatch[1]}`;

  return value;
}
