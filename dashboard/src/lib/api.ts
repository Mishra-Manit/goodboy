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

export interface Task {
  id: string;
  repo: string;
  description: string;
  status: string;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  prNumber: number | null;
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
  status: string;
  startedAt: string;
  completedAt: string | null;
  piSessionId: string | null;
  error: string | null;
}

export interface TaskDetail extends Task {
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
  status: string;
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
}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.repo) params.set("repo", filters.repo);
  const qs = params.toString();
  return request(`/api/tasks${qs ? `?${qs}` : ""}`);
}

export async function fetchTask(id: string): Promise<TaskDetail> {
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

export async function fetchRepos(): Promise<Repo[]> {
  return request("/api/repos");
}

export async function fetchPRs(): Promise<PR[]> {
  return request("/api/prs");
}
