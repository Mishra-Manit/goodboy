/** Track which files a user has viewed in a PR review, persisted per headSha. */

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "pr-review:viewed:";

function loadViewed(headSha: string): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + headSha);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveViewed(headSha: string, viewed: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + headSha, JSON.stringify([...viewed]));
  } catch { /* ignore */ }
}

interface UseViewedFilesResult {
  viewed: Set<string>;
  toggleViewed: (file: string) => void;
}

/** Files start unviewed; only explicit user clicks toggle the viewed state. */
export function useViewedFiles(headSha: string): UseViewedFilesResult {
  const [viewed, setViewed] = useState<Set<string>>(() => loadViewed(headSha));

  // Reset when headSha changes (new commit pushed)
  useEffect(() => {
    setViewed(loadViewed(headSha));
  }, [headSha]);

  const toggleViewed = useCallback((file: string) => {
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      saveViewed(headSha, next);
      return next;
    });
  }, [headSha]);

  return { viewed, toggleViewed };
}
