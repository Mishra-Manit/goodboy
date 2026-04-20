/** One registered repo, shown on the Repos page. */

import { ExternalLink } from "lucide-react";
import type { Repo } from "@dashboard/lib/api";

interface RepoRowProps {
  repo: Repo;
}

export function RepoRow({ repo }: RepoRowProps) {
  return (
    <div className="group rounded-lg bg-glass px-4 py-3.5 animate-fade-up">
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-sm font-medium text-text">{repo.name}</span>
        {repo.githubUrl && (
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
          >
            <ExternalLink size={10} />
            github
          </a>
        )}
      </div>
      <code className="font-mono text-[11px] text-text-void">{repo.localPath}</code>
    </div>
  );
}
