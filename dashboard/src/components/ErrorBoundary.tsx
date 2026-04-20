/** Top-level uncaught-error screen. Mounted once from `main.tsx`. */

import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-center">
          <p className="font-mono text-sm text-fail">something went wrong</p>
          <p className="mt-2 font-mono text-xs text-text-ghost max-w-md">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 font-mono text-xs text-text-ghost hover:text-accent"
          >
            reload
          </button>
        </div>
      </div>
    );
  }
}
