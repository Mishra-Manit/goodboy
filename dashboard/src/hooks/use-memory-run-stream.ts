/**
 * Live transcript tail for one memory run. Uses a dedicated SSE endpoint that
 * watches the run's session file on the server, so manual-test runs stream
 * even though they execute outside the dashboard process.
 */

import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@dashboard/lib/api";

interface UseMemoryRunStreamOptions {
  runId: string;
  enabled?: boolean;
  onRunUpdate?: () => void;
}

/** Append every streamed entry for `runId`; caller handles de-duping. */
export function useMemoryRunStream({
  runId,
  enabled = true,
  onRunUpdate,
}: UseMemoryRunStreamOptions): FileEntry[] {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const onRunUpdateRef = useRef(onRunUpdate);
  onRunUpdateRef.current = onRunUpdate;

  useEffect(() => {
    if (!enabled) {
      setEntries([]);
      return;
    }

    setEntries([]);

    const es = new EventSource(`/api/memory/runs/${runId}/events`);

    const handleSessionEntry = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(event.data) as { entry: FileEntry };
        setEntries((prev) => [...prev, data.entry]);
      } catch {
        // ignore malformed events
      }
    };

    const handleRunUpdate = (): void => {
      onRunUpdateRef.current?.();
    };

    es.addEventListener("session_entry", handleSessionEntry as EventListener);
    es.addEventListener("memory_run_update", handleRunUpdate as EventListener);

    return () => {
      es.removeEventListener("session_entry", handleSessionEntry as EventListener);
      es.removeEventListener("memory_run_update", handleRunUpdate as EventListener);
      es.close();
    };
  }, [enabled, runId]);

  return entries;
}
