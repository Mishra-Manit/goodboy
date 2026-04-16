const defaultHeaders: HeadersInit = {
  "Content-Type": "application/json",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...defaultHeaders, ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// --- Types mirroring backend ---

export type TaskKind = "coding_task" | "codebase_question" | "pr_review";

export type TaskStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export const TASK_KIND_CONFIG: Record<TaskKind, {
  label: string;
  stages: string[];
  artifacts: { key: string; label: string }[];
}> = {
  coding_task: {
    label: "coding task",
    stages: ["planner", "implementer", "reviewer"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};

export type StageStatus = "running" | "complete" | "failed";

export interface Task {
  id: string;
  repo: string;
  kind: TaskKind;
  description: string;
  status: TaskStatus;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prIdentifier: string | null;
  error: string | null;
  telegramChatId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskStage {
  id: string;
  taskId: string;
  stage: string;
  status: StageStatus;
  startedAt: string;
  completedAt: string | null;
  piSessionId: string | null;
  error: string | null;
}

export interface TaskWithStages extends Task {
  stages: TaskStage[];
}

export interface Repo {
  name: string;
  localPath: string;
  githubUrl?: string;
}

export interface PR {
  taskId: string;
  repo: string;
  prUrl: string | null;
  prNumber: number | null;
  status: TaskStatus;
}

export type PrSessionStatus = "active" | "closed";

export interface PrSession {
  id: string;
  repo: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  worktreePath: string | null;
  status: PrSessionStatus;
  originTaskId: string | null;
  telegramChatId: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrSessionRun {
  id: string;
  prSessionId: string;
  trigger: string;
  comments: Array<{ author: string; body: string; path?: string; line?: number }> | null;
  status: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PrSessionWithRuns extends PrSession {
  runs: PrSessionRun[];
}

export type LogEntryKind =
  | "text"
  | "tool_start"
  | "tool_end"
  | "tool_output"
  | "stage_info"
  | "rpc"
  | "error"
  | "stderr";

export interface LogEntry {
  seq: number;
  ts: string;
  kind: LogEntryKind;
  text: string;
  meta?: Record<string, unknown>;
}

export interface StageLogs {
  stage: string;
  entries: LogEntry[];
}

// --- Endpoints ---

export async function fetchTasks(filters?: {
  status?: string;
  repo?: string;
  kind?: string;
}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.repo) params.set("repo", filters.repo);
  if (filters?.kind) params.set("kind", filters.kind);
  const qs = params.toString();
  return request(`/api/tasks${qs ? `?${qs}` : ""}`);
}

export async function fetchTask(id: string): Promise<TaskWithStages> {
  return request(`/api/tasks/${id}`);
}

export async function fetchTaskLogs(
  id: string
): Promise<{ logs: StageLogs[] }> {
  return request(`/api/tasks/${id}/logs`);
}

export async function fetchArtifact(
  taskId: string,
  name: string
): Promise<string> {
  const res = await fetch(`/api/tasks/${taskId}/artifacts/${name}`);
  if (!res.ok) throw new Error(`Artifact not found: ${name}`);
  return res.text();
}

export async function retryTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/retry`, { method: "POST" });
}

export async function cancelTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/cancel`, { method: "POST" });
}

export async function dismissTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/dismiss`, { method: "POST" });
}

export async function fetchRepos(): Promise<Repo[]> {
  return request("/api/repos");
}

export async function fetchPRs(): Promise<PR[]> {
  return request("/api/prs");
}

export async function fetchPrSessions(): Promise<PrSession[]> {
  return request("/api/pr-sessions");
}

export async function fetchPrSessionDetail(
  id: string,
): Promise<PrSessionWithRuns> {
  return request(`/api/pr-sessions/${id}`);
}

export async function fetchPrSessionLogs(
  id: string,
): Promise<{ entries: LogEntry[] }> {
  return request(`/api/pr-sessions/${id}/logs`);
}
