/**
 * Reviewer feedback memory viewer. Shows all durable rules learned from
 * PR comments and chat for a specific repo, with scope and status filtering.
 */

import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Brain, FileCode2, MessageSquare, Globe, Tag } from "lucide-react";
import {
  fetchReviewerFeedback,
  type FeedbackListStatus,
  type CodeReviewerFeedbackRule,
  type CodeReviewerFeedbackScope,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { cn } from "@dashboard/lib/utils";

const STATUS_FILTERS = ["all", "active", "inactive"] as const;
const SCOPE_FILTERS = ["all", "global", "path", "review_behavior"] as const;
type ScopeFilter = (typeof SCOPE_FILTERS)[number];

export function ReviewerFeedback() {
  const { repo } = useParams<{ repo: string }>();
  if (!repo) return <Navigate to="/memory" replace />;

  const navigate = useNavigate();
  const [status, setStatus] = useState<FeedbackListStatus>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const { data, loading, error, refetch } = useQuery(
    `reviewer-feedback:${repo}:${status}`,
    () => fetchReviewerFeedback(repo, status),
  );

  const filtered =
    data && scope !== "all" ? data.filter((rule) => rule.scope.type === scope) : data;

  const activeCount = data?.filter((r) => r.status === "active").length ?? 0;
  const inactiveCount = data?.filter((r) => r.status === "inactive").length ?? 0;

  return (
    <div className="animate-fade-in">
      <BackLink label="memory" onClick={() => navigate("/memory")} />

      <header className="mb-8">
        <div className="mb-1 flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10">
            <Brain size={13} className="text-accent" />
          </div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-text">
            Reviewer Memory
          </h1>
        </div>
        <p className="font-mono text-[11px] text-text-ghost">
          <span className="text-text-dim">{repo}</span>
          <span className="mx-1.5 text-text-void">·</span>
          durable rules learned from PR feedback
        </p>
      </header>

      {data && (
        <div className="mb-6 grid grid-cols-3 gap-2">
          <StatTile label="total rules" value={data.length} />
          <StatTile label="active" value={activeCount} accent />
          <StatTile label="inactive" value={inactiveCount} muted />
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <FilterPill
              key={f}
              label={f}
              active={status === f}
              onClick={() => setStatus(f as FeedbackListStatus)}
            />
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          {SCOPE_FILTERS.map((f) => (
            <FilterPill
              key={f}
              label={f === "review_behavior" ? "behavior" : f}
              active={scope === f}
              onClick={() => setScope(f)}
            />
          ))}
        </div>
      </div>

      <PageState
        data={filtered}
        loading={loading}
        error={error}
        onRetry={refetch}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No rules found"
            description="Reviewer memory rules appear here once the agent learns from PR comments or dashboard chat."
          />
        }
      >
        {(rules) => {
          const byScope = groupByScope(rules);

          return (
            <div className="space-y-8">
              {byScope.map(([scopeType, scopeRules]) => (
                <section key={scopeType}>
                  <SectionDivider
                    label={scopeLabelText(scopeType)}
                    detail={`${scopeRules.length}`}
                  />
                  <div className="mt-3 space-y-2 stagger">
                    {scopeRules.map((rule) => (
                      <RuleCard key={rule.id} rule={rule} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          );
        }}
      </PageState>
    </div>
  );
}

// --- Sub-components ---

interface StatTileProps {
  label: string;
  value: number;
  accent?: boolean;
  muted?: boolean;
}

function StatTile({ label, value, accent, muted }: StatTileProps) {
  return (
    <div className="rounded-lg border border-glass-border bg-glass/40 px-3 py-2.5">
      <div
        className={cn(
          "font-mono text-xl font-bold tabular-nums",
          accent ? "text-accent" : muted ? "text-text-ghost" : "text-text",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-text-void">
        {label}
      </div>
    </div>
  );
}

interface FilterPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterPill({ label, active, onClick }: FilterPillProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
        active
          ? "bg-glass border border-accent/20 text-text"
          : "text-text-ghost hover:text-text-dim",
      )}
    >
      {label}
    </button>
  );
}

interface RuleCardProps {
  rule: CodeReviewerFeedbackRule;
}

function RuleCard({ rule }: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isActive = rule.status === "active";

  return (
    <div
      className={cn(
        "group rounded-lg border bg-glass/40 px-4 py-3 transition-all duration-200",
        "hover:bg-glass-hover",
        isActive
          ? "border-glass-border hover:border-accent/20"
          : "border-glass-border/40 opacity-60 hover:opacity-80",
      )}
    >
      {/* Header row */}
      <div className="mb-2 flex items-start gap-2">
        <ScopeBadge scope={rule.scope} />
        <div className="min-w-0 flex-1">
          <span className="font-body text-[12px] font-medium text-text leading-snug">
            {rule.title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest",
              isActive
                ? "bg-accent/10 text-accent"
                : "bg-glass border border-glass-border text-text-void",
            )}
          >
            {rule.status}
          </span>
          <span className="font-mono text-[9px] text-text-void">{rule.id}</span>
        </div>
      </div>

      {/* Rule body */}
      <p className="mb-2.5 font-body text-[11px] leading-relaxed text-text-secondary">
        {rule.rule}
      </p>

      {/* Path list for path-scoped rules */}
      {rule.scope.type === "path" && (
        <div className="mb-2.5 flex flex-wrap gap-1">
          {rule.scope.paths.map((p) => (
            <span
              key={p}
              className="rounded bg-glass px-1.5 py-0.5 font-mono text-[9px] text-info"
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Source toggle */}
      <div className="flex items-center gap-2">
        <SourceChip type={rule.source.type} prNumber={rule.source.prNumber} />
        <span className="text-text-void">·</span>
        <span className="font-mono text-[9px] text-text-void">
          {formatDate(rule.createdAt)}
        </span>
        {rule.updatedAt !== rule.createdAt && (
          <>
            <span className="text-text-void">·</span>
            <span className="font-mono text-[9px] text-text-void">
              updated {formatDate(rule.updatedAt)}
            </span>
          </>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto font-mono text-[9px] text-text-void transition-colors hover:text-text-ghost"
        >
          {expanded ? "hide source" : "show source"}
        </button>
      </div>

      {/* Original text */}
      {expanded && (
        <div className="mt-3 rounded-md border border-glass-border bg-bg-raised p-3">
          <p className="font-mono text-[10px] leading-relaxed text-text-ghost whitespace-pre-wrap break-words">
            {rule.source.originalText}
          </p>
        </div>
      )}
    </div>
  );
}

interface ScopeBadgeProps {
  scope: CodeReviewerFeedbackScope;
}

function ScopeBadge({ scope }: ScopeBadgeProps) {
  if (scope.type === "global") {
    return (
      <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full bg-accent/8 px-2 py-0.5 font-mono text-[9px] text-accent">
        <Globe size={9} />
        global
      </span>
    );
  }
  if (scope.type === "path") {
    return (
      <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 font-mono text-[9px] text-info">
        <FileCode2 size={9} />
        path
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full bg-comment/10 px-2 py-0.5 font-mono text-[9px] text-comment">
      <Tag size={9} />
      behavior
    </span>
  );
}

interface SourceChipProps {
  type: "github_comment" | "dashboard_chat";
  prNumber: number;
}

function SourceChip({ type, prNumber }: SourceChipProps) {
  return (
    <span className="flex items-center gap-1 font-mono text-[9px] text-text-void">
      <MessageSquare size={9} />
      {type === "github_comment" ? "gh" : "chat"} · PR #{prNumber}
    </span>
  );
}

// --- Helpers ---

function groupByScope(
  rules: CodeReviewerFeedbackRule[],
): Array<[string, CodeReviewerFeedbackRule[]]> {
  const order = ["global", "path", "review_behavior"];
  const map = new Map<string, CodeReviewerFeedbackRule[]>();

  for (const rule of rules) {
    const key = rule.scope.type;
    const bucket = map.get(key) ?? [];
    bucket.push(rule);
    map.set(key, bucket);
  }

  return order
    .filter((key) => map.has(key))
    .map((key) => [key, map.get(key)!] as [string, CodeReviewerFeedbackRule[]]);
}

function scopeLabelText(type: string): string {
  if (type === "review_behavior") return "review behavior";
  return type;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
