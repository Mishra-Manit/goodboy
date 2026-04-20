import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Pure relative-time formatter. Accepts an explicit `nowMs` so callers can
 * drive live updates via the `useNow` hook; defaults to `Date.now()` for
 * one-off formatting (logs, non-React code).
 */
export function timeAgo(dateStr: string, nowMs: number = Date.now()): string {
  const seconds = Math.floor(
    (nowMs - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
