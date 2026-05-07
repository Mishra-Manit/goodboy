/** Repo selection dropdown for the PR inbox header. */

import { cn } from "@dashboard/lib/utils";

interface RepoSelectProps {
  value: string;
  repos: readonly string[];
  onChange: (repo: string) => void;
}

export function RepoSelect({ value, repos, onChange }: RepoSelectProps) {
  return (
    <label className="group relative inline-flex items-center">
      <span className="sr-only">Repository</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-8 min-w-36 appearance-none rounded-full border border-glass-border bg-glass",
          "px-3 pr-9 font-mono text-[11px] tracking-wide text-text outline-none",
          "transition-colors hover:border-glass-hover focus:border-accent/60",
        )}
      >
        {repos.map((repo) => (
          <option key={repo} value={repo} className="bg-bg text-text">{repo}</option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 h-1.5 w-1.5 rotate-45 border-b border-r border-text-ghost transition-colors group-hover:border-text-dim"
      />
    </label>
  );
}
