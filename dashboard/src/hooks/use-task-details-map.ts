/**
 * Shared hook that fetches and live-updates TaskWithStages details for a set
 * of active task IDs. Eliminates the duplicated SSE+fetch pattern in
 * PullRequests and Tasks pages.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchTask, type TaskWithStages } from "@dashboard/lib/api";
import { useSSE } from "@dashboard/hooks/use-sse";

export function useTaskDetailsMap(activeIds: string[]): Map<string, TaskWithStages> {
  const [details, setDetails] = useState<Map<string, TaskWithStages>>(new Map());

  // Fetch details for any active IDs we haven't loaded yet.
  useEffect(() => {
    const missingIds = activeIds.filter((id) => !details.has(id));
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(missingIds.map((id) => fetchTask(id))).then((fetched) => {
      if (cancelled) return;
      setDetails((prev) =>
        fetched.reduce((next, detail) => new Map(next).set(detail.id, detail), prev),
      );
    });

    return () => { cancelled = true; };
  }, [activeIds, details]);

  // Keep details fresh as stages progress via SSE.
  const idSet = useMemo(() => new Set(activeIds), [activeIds]);

  useSSE((event) => {
    if (event.type !== "stage_update" && event.type !== "task_update") return;
    if (!idSet.has(event.taskId)) return;
    fetchTask(event.taskId).then((detail) =>
      setDetails((prev) => new Map(prev).set(event.taskId, detail)),
    );
  });

  return details;
}
