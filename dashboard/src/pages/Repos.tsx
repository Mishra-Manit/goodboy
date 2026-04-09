import { ExternalLink } from "lucide-react";
import { fetchRepos, type Repo } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";

export function Repos() {
  const { data: repos, loading } = useQuery(() => fetchRepos());

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">
          Repositories
        </h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          registered via REGISTERED_REPOS in .env
        </p>
      </header>

      {loading && !repos ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            loading...
          </span>
        </div>
      ) : (repos ?? []).length === 0 ? (
        <EmptyState
          title="No repos registered"
          description="Add repos to the database to get started"
        />
      ) : (
        <>
          <SectionDivider label="registered" detail={`${(repos ?? []).length}`} />
          <div className="mt-4 space-y-3 stagger">
            {(repos ?? []).map((repo) => (
              <RepoRow key={repo.name} repo={repo} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  return (
    <div className="group rounded-lg bg-glass px-4 py-3.5 animate-fade-up">
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-sm font-medium text-text">
          {repo.name}
        </span>
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
      <code className="font-mono text-[11px] text-text-void">
        {repo.localPath}
      </code>
    </div>
  );
}
