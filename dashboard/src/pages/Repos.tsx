/** Registered repos page. */

import { fetchRepos } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { PageState } from "@dashboard/components/PageState";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { RepoRow } from "@dashboard/components/rows/RepoRow";

export function Repos() {
  const { data, loading, error, refetch } = useQuery("repos", fetchRepos);

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">Repositories</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          registered via REGISTERED_REPOS in .env
        </p>
      </header>

      <PageState
        data={data}
        loading={loading}
        error={error}
        onRetry={refetch}
        isEmpty={(repos) => repos.length === 0}
        empty={<EmptyState title="No repos registered" description="Add repos to the database to get started" />}
      >
        {(repos) => (
          <>
            <SectionDivider label="registered" detail={`${repos.length}`} />
            <div className="mt-4 space-y-3 stagger">
              {repos.map((repo) => (
                <RepoRow key={repo.name} repo={repo} />
              ))}
            </div>
          </>
        )}
      </PageState>
    </div>
  );
}
