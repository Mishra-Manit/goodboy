/** Pure display helpers for PR review tasks. */

import type { Task } from "@dashboard/lib/api";

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
