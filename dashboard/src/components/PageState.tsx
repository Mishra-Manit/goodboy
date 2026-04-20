/**
 * Three-state guard required by every page per AGENTS: spinner while
 * (loading && !data), error + retry while (error && !data), empty when
 * `isEmpty(data)` says so, otherwise render children(data).
 */

import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState.js";

interface PageStateProps<T> {
  data: T | null | undefined;
  loading: boolean;
  error: string | null;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loadingLabel?: string;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}

export function PageState<T>({
  data,
  loading,
  error,
  isEmpty,
  empty,
  loadingLabel = "loading...",
  onRetry,
  children,
}: PageStateProps<T>): ReactNode {
  if (loading && !data) {
    return (
      <div className="py-12 text-center">
        <span className="font-mono text-xs text-text-ghost animate-pulse-soft">{loadingLabel}</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-fail">{error}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 block mx-auto font-mono text-xs text-text-ghost hover:text-accent"
          >
            retry
          </button>
        )}
      </div>
    );
  }

  if (!data) return null;

  if (isEmpty?.(data)) {
    return empty ?? <EmptyState title="Nothing here" />;
  }

  return <>{children(data)}</>;
}
