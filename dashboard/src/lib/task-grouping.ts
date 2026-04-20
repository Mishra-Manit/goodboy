/** Group completed tasks into today / yesterday / this week / older buckets. */

import type { Task } from "@dashboard/lib/api";

export interface TaskGroup {
  label: string;
  tasks: Task[];
}

const ORDER = ["today", "yesterday", "this week", "older"] as const;

export function groupByDate(tasks: Task[]): TaskGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);

  const groups: Record<string, Task[]> = {};
  for (const task of tasks) {
    const d = new Date(task.createdAt);
    const label =
      d >= today ? "today"
      : d >= yesterday ? "yesterday"
      : d >= weekAgo ? "this week"
      : "older";
    (groups[label] ??= []).push(task);
  }

  return ORDER.filter((l) => groups[l]?.length).map((label) => ({ label, tasks: groups[label] }));
}
