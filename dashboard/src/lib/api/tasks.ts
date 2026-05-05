/** Task + artifact endpoints. */

import { taskPrReviewPageDtoSchema } from "@dashboard/shared";
import { request, requestJson, requestText } from "./client.js";
import type { Task, TaskWithStages, StageSession, RetryTaskResponse, TaskPrReviewPageDto } from "./types.js";

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

export async function fetchTaskSession(id: string): Promise<{ stages: StageSession[] }> {
  return request(`/api/tasks/${id}/session`);
}

export async function fetchArtifact(taskId: string, name: string): Promise<string> {
  return requestText(`/api/tasks/${taskId}/artifacts/${name}`);
}

export async function fetchTaskPrReviewPage(taskId: string): Promise<TaskPrReviewPageDto> {
  return requestJson(`/api/tasks/${taskId}/review`, taskPrReviewPageDtoSchema);
}

export async function retryTask(id: string): Promise<RetryTaskResponse> {
  return request(`/api/tasks/${id}/retry`, { method: "POST" });
}

export async function cancelTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/cancel`, { method: "POST" });
}

export async function dismissTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/dismiss`, { method: "POST" });
}
