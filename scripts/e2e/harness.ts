/**
 * Real pipeline E2E client. It asks the running Goodboy server to launch work
 * so dashboard SSE and cancellation share the same process as the pipeline.
 */

import "dotenv/config";

import { stat } from "node:fs/promises";
import path from "node:path";
import { writeE2eManifest, writeE2eReport, type E2eManifest } from "./report.js";
import { createTerminalReporter } from "./terminal-reporter.js";
import type { SSEEvent, StageName, TaskKind, TaskStatus } from "../../src/shared/domain/types.js";

const BASE_URL = "http://localhost:3000";
const REPO = process.env.E2E_REPO ?? "pantheon";
const CHAT_ID = "goodboy-e2e";
const POLL_MS = 2_000;
const ARTIFACTS_DIR = path.resolve("artifacts");

export const OWNED_PROMPT = process.env.E2E_PROMPT ?? `Feature: Filter Advisor — Automated Filter Discovery and Performance Attribution

A new agent pipeline that closes the loop between trade outcomes and Scout's discovery criteria.

What it does:

1. Attribution engine — queries closed_positions, trade_closes, and opportunities to compute per-prefix stats: win rate, average PnL, average hold time, entry price distribution, and sample size. Groups by event prefix (same bucketing as filters.py).
2. FilterAdvisor agent — takes the attribution report + current learnings + current filters.py rules and produces structured proposals: new safe prefixes to add, existing ones to downgrade to price-gated, and price thresholds to tighten/loosen based on empirical data.
3. filter_proposals table — stores proposed changes with supporting stats, status (pending / approved / rejected), and a confidence score. Nothing auto-applies without a threshold.
4. Auto-apply path — when a proposal hits a configurable confidence gate (e.g., 15+ events, 90%+ win rate), it can optionally be applied directly to a dynamic_filters DB table that Scout reads alongside the static filters.py. Static file remains the safety backstop.
5. CLI command — python -m coliseum filter-advisor runs attribution and the agent on demand; daemon can trigger it every N cycles after Scribe runs.
6. Dashboard endpoint — /api/filter-proposals and /api/performance-attribution for visibility into what the system is learning about its own alpha sources.

Dashboard requirements:
- Create frontend/components/chart/filter-attribution-panel.tsx.
- Render <FilterAttributionPanel /> directly below <WinRatePanel /> in frontend/app/chart/page.tsx.
- Do not create a new route or navbar item.

build this for the pantheon project`;

interface Task {
  id: string;
  repo: string;
  kind: TaskKind;
  status: TaskStatus;
  error: string | null;
  prUrl: string | null;
  prNumber: number | null;
}

interface PrSession {
  id: string;
  mode: "own" | "review";
}

interface OwnedRun {
  manifest: E2eManifest;
  task: Task;
}

interface ExpectedStageSession {
  stage: StageName;
  variant?: number;
}

// --- Public scenarios ---

export async function runOwnedOnly(): Promise<void> {
  const stream = createEventStream();
  let manifest = newManifest("owned");
  try {
    await preflight(stream.ready);
    const owned = await runOwnedScenario(manifest, stream.trackedTaskIds);
    manifest = { ...owned.manifest, completedAt: new Date().toISOString() };
    await writeManifest(manifest);
    const reportPath = await writeE2eReport({ manifest, result: "pass", taskIds: [owned.task.id] });
    console.log(`\nE2E owned complete: ${owned.task.prUrl}`);
    console.log(`[report] ${reportPath}`);
  } catch (err) {
    const failedManifest = { ...manifest, completedAt: new Date().toISOString() };
    await writeManifest(failedManifest);
    const reportPath = await writeE2eReport({ manifest: failedManifest, result: "fail", taskIds: [...stream.trackedTaskIds], error: err });
    console.log(`[report] ${reportPath}`);
    throw err;
  } finally {
    await stream.stop();
  }
}

export async function runOwnedThenReview(): Promise<void> {
  const stream = createEventStream();
  let manifest = newManifest("owned-review");
  try {
    await preflight(stream.ready);
    const owned = await runOwnedScenario(manifest, stream.trackedTaskIds);
    manifest = owned.manifest;
    if (!owned.task.prNumber) throw new Error("Owned task completed without a PR number");

    const review = await launchReview(owned.task.prNumber);
    stream.trackedTaskIds.add(review.id);
    console.log(`\nReview task ${review.id} started for PR #${owned.task.prNumber}`);

    const reviewTask = await waitForCompleteTask(review.id, "review");
    await assertTaskArtifacts(reviewTask.id, [
      { stage: "pr_impact", variant: 1 },
      { stage: "pr_analyst" },
    ]);

    manifest = {
      ...owned.manifest,
      reviewTaskId: reviewTask.id,
      reviewArtifactsDir: taskArtifactsDir(reviewTask.id),
      completedAt: new Date().toISOString(),
    };
    await writeManifest(manifest);
    const reportPath = await writeE2eReport({ manifest, result: "pass", taskIds: [owned.task.id, reviewTask.id] });
    console.log(`\nE2E owned + review complete: ${owned.task.prUrl}`);
    console.log(`[report] ${reportPath}`);
  } catch (err) {
    const failedManifest = { ...manifest, completedAt: new Date().toISOString() };
    await writeManifest(failedManifest);
    const reportPath = await writeE2eReport({ manifest: failedManifest, result: "fail", taskIds: [...stream.trackedTaskIds], error: err });
    console.log(`[report] ${reportPath}`);
    throw err;
  } finally {
    await stream.stop();
  }
}

// --- Scenario steps ---

async function runOwnedScenario(manifest: E2eManifest, trackedTaskIds: Set<string>): Promise<OwnedRun> {
  await writeManifest(manifest);

  const launched = await launchOwned();
  trackedTaskIds.add(launched.id);
  console.log(`\nOwned task ${launched.id} started for ${REPO}`);

  const task = await waitForCompleteTask(launched.id, "owned");
  if (!task.prUrl || !task.prNumber) throw new Error("Owned task completed without PR metadata");
  await assertTaskArtifacts(task.id, [
    { stage: "planner" },
    { stage: "implementer" },
    { stage: "reviewer" },
    { stage: "pr_creator" },
  ]);

  const session = await requireOwnedPrSession(task);
  const nextManifest = {
    ...manifest,
    ownedTaskId: task.id,
    ownedArtifactsDir: taskArtifactsDir(task.id),
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    prSessionId: session.id,
  };
  await writeManifest(nextManifest);
  return { manifest: nextManifest, task };
}

async function preflight(streamReady: Promise<void>): Promise<void> {
  await streamReady;
  const repos = await requestJson<readonly { name: string; githubUrl?: string }[]>("/api/repos");
  const repo = repos.find((item) => item.name === REPO);
  if (!repo?.githubUrl) throw new Error(`Repo '${REPO}' must be registered with a GitHub URL on ${BASE_URL}`);

  console.log("=== Goodboy server-owned real pipeline E2E ===");
  console.log(`server     : ${BASE_URL}`);
  console.log(`repo       : ${REPO} (${repo.githubUrl})`);
  console.log(`prompt     : ${OWNED_PROMPT.split("\n")[0]}`);
  console.log(`prompt_len : ${OWNED_PROMPT.length} chars`);
}

async function launchOwned(): Promise<Task> {
  const response = await requestJson<{ task: Task }>("/api/e2e/owned", {
    method: "POST",
    body: JSON.stringify({ repo: REPO, prompt: OWNED_PROMPT, chatId: CHAT_ID }),
  });
  return response.task;
}

async function launchReview(prNumber: number): Promise<Task> {
  const response = await requestJson<{ task: Task }>("/api/e2e/pr-review", {
    method: "POST",
    body: JSON.stringify({ repo: REPO, prNumber, chatId: CHAT_ID }),
  });
  return response.task;
}

async function waitForCompleteTask(taskId: string, label: string): Promise<Task> {
  while (true) {
    const task = await requestJson<Task>(`/api/tasks/${taskId}`);
    if (task.status === "complete") return task;
    if (task.status === "failed" || task.status === "cancelled") {
      throw new Error(`${label} task ended as ${task.status}: ${task.error ?? "no error"}`);
    }
    await sleep(POLL_MS);
  }
}

async function requireOwnedPrSession(task: Task): Promise<PrSession> {
  if (!task.prNumber) throw new Error("Owned task has no PR number");
  const sessions = await requestJson<readonly PrSession[]>(`/api/pr-sessions?sourceTaskId=${task.id}`);
  const session = sessions.find((item) => item.mode === "own");
  if (!session) throw new Error(`No active owned PR session found for PR #${task.prNumber}`);
  return session;
}

// --- Assertions ---

async function assertTaskArtifacts(taskId: string, stages: readonly ExpectedStageSession[]): Promise<void> {
  const dir = taskArtifactsDir(taskId);
  await assertExists(dir, `artifact directory missing for ${taskId}`);
  await Promise.all(stages.map(({ stage, variant }) => (
    assertExists(taskSessionPath(taskId, stage, variant), `session missing: ${stage}${variant ? `#${variant}` : ""}`)
  )));
}

async function assertExists(filePath: string, message: string): Promise<void> {
  const exists = await stat(filePath).then(() => true).catch(() => false);
  if (!exists) throw new Error(`${message}\n${filePath}`);
}

// --- Manifest ---

function newManifest(kind: string): E2eManifest {
  return {
    runId: `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    repo: REPO,
    prompt: OWNED_PROMPT,
    startedAt: new Date().toISOString(),
  };
}

async function writeManifest(manifest: E2eManifest): Promise<void> {
  await writeE2eManifest(manifest);
}

function taskArtifactsDir(taskId: string): string {
  return path.join(ARTIFACTS_DIR, taskId);
}

function taskSessionPath(taskId: string, stage: StageName, variant?: number): string {
  const suffix = variant === undefined ? "" : `.v${variant}`;
  return path.join(taskArtifactsDir(taskId), `${stage}${suffix}.session`, `${stage}${suffix}.session.jsonl`);
}

// --- HTTP + SSE ---

async function requestJson<T>(urlPath: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

function createEventStream(): { trackedTaskIds: Set<string>; ready: Promise<void>; stop: () => Promise<void> } {
  const trackedTaskIds = new Set<string>();
  const controller = new AbortController();
  const reportEvent = createTerminalReporter();
  let ready!: () => void;
  let failReady!: (err: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failReady = reject;
  });

  const done = runEventStream(trackedTaskIds, controller.signal, ready, failReady, reportEvent).catch((err) => {
    if (!controller.signal.aborted) console.warn(`SSE stream stopped: ${err instanceof Error ? err.message : String(err)}`);
  });
  return {
    trackedTaskIds,
    ready: readyPromise,
    stop: async () => {
      controller.abort();
      await done.catch(() => {});
    },
  };
}

async function runEventStream(
  trackedTaskIds: Set<string>,
  signal: AbortSignal,
  ready: () => void,
  failReady: (err: unknown) => void,
  reportEvent: (event: SSEEvent) => void,
): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/events`, { signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    ready();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) printSseBlock(part, trackedTaskIds, reportEvent);
    }
  } catch (err) {
    if (signal.aborted) return;
    failReady(err);
    throw err;
  }
}

function printSseBlock(block: string, trackedTaskIds: Set<string>, reportEvent: (event: SSEEvent) => void): void {
  const data = block.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return;

  const event = JSON.parse(data) as SSEEvent;
  if (!isTrackedEvent(event, trackedTaskIds)) return;
  reportEvent(event);
}

function isTrackedEvent(event: SSEEvent, ids: Set<string>): boolean {
  if (ids.size === 0) return false;
  if (event.type === "task_update" || event.type === "stage_update") return ids.has(event.taskId);
  if (event.type === "session_entry" && event.scope === "task") return ids.has(event.id);
  if (event.type === "memory_run_update") return ids.has(event.sessionTaskId);
  return event.type === "pr_session_update";
}

// --- Helpers ---

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
