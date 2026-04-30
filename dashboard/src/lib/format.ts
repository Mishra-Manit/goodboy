/** Pure time + number formatters. Used everywhere lists, badges, or logs render a count. */

/** `Apr 20, 10:34`. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative time driven by an explicit `nowMs` so callers can use `useNow()` for live ticking. */
export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const seconds = Math.floor((nowMs - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Elapsed duration between two ISO timestamps, e.g. `230ms`, `12s`, `2m 30s`, `1h 15m`.
 * Floored at 0 so cross-host clock skew on fast runs can never render a negative duration.
 */
export function formatDuration(startIso: string, endIso: string): string {
  return formatMs(Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime()));
}

/** Duration formatter for raw millisecond counts (tool runtimes, etc.). */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

/** Compact token count: `1234` → `1.2k`. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** `HH:MM:SS` for log timestamps. Swallows bad input. */
export function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
