/** Track which files a user has viewed in a PR review, persisted per headSha. */

import { useCallback, useEffect, useRef, useState } from "react";

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
  markViewed: (file: string) => void;
}

/** Auto-marks a file as viewed after it stays active for `AUTO_MARK_MS`. */
const AUTO_MARK_MS = 2000;

export function useViewedFiles(headSha: string, activeFile: string | null): UseViewedFilesResult {
  const [viewed, setViewed] = useState<Set<string>>(() => loadViewed(headSha));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when headSha changes (new commit pushed)
  useEffect(() => {
    setViewed(loadViewed(headSha));
  }, [headSha]);

  // Auto-mark after dwelling on a file
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!activeFile) return;

    timerRef.current = setTimeout(() => {
      setViewed((prev) => {
        if (prev.has(activeFile)) return prev;
        const next = new Set(prev);
        next.add(activeFile);
        saveViewed(headSha, next);
        return next;
      });
    }, AUTO_MARK_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeFile, headSha]);

  const toggleViewed = useCallback((file: string) => {
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      saveViewed(headSha, next);
      return next;
    });
  }, [headSha]);

  const markViewed = useCallback((file: string) => {
    setViewed((prev) => {
      if (prev.has(file)) return prev;
      const next = new Set(prev);
      next.add(file);
      saveViewed(headSha, next);
      return next;
    });
  }, [headSha]);

  return { viewed, toggleViewed, markViewed };
}
