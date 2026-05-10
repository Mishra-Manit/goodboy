/**
 * Human-readable E2E terminal summaries and markdown reports. The raw pi
 * JSONL sessions remain the forensic source; this file distills them into
 * stage, tool, token, cost, and acceptance tables.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { taskSessionPath, readSessionFile } from "../../src/core/pi/session-file.js";
import * as queries from "../../src/db/repository.js";
import { getRepo } from "../../src/shared/domain/repos.js";
import { config } from "../../src/shared/runtime/config.js";
import { toErrorMessage } from "../../src/shared/runtime/errors.js";
import type { TaskStage } from "../../src/db/repository.js";
import type {
  AssistantMessage,
  BashExecutionMessage,
  FileEntry,
  SessionEntry,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "../../src/shared/contracts/session.js";
import type { StageName } from "../../src/shared/domain/types.js";

const FAILURE_OUTPUT_LINES = 40;
const MAX_TARGET_CHARS = 140;
const FILTER_ATTRIBUTION_COMPONENT = "frontend/components/chart/filter-attribution-panel.tsx";
const CHART_PAGE = "frontend/app/chart/page.tsx";

export interface E2eManifest {
  runId: string;
  repo: string;
  prompt: string;
  startedAt: string;
  completedAt?: string;
  ownedTaskId?: string;
  ownedArtifactsDir?: string;
  prUrl?: string | null;
  prNumber?: number | null;
  prSessionId?: string | null;
  reviewTaskId?: string;
  reviewArtifactsDir?: string;
}

export interface WriteReportInput {
  manifest: E2eManifest;
  result: "pass" | "fail";
  taskIds: readonly string[];
  error?: unknown;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
}

interface StageRunSummary {
  taskId: string;
  stage: StageName;
  variant?: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number;
  provider: string;
  model: string;
  stopReasons: Record<string, number>;
  errors: number;
  usage: UsageTotals;
  sessionPath: string;
  sessionExists: boolean;
}

interface ToolActivity {
  stage: StageName;
  variant?: number;
  tool: string;
  target: string;
  status: "pass" | "fail" | "running";
  details: string;
  outputTail?: string;
}

interface SubagentRun {
  parentStage: StageName;
  variant?: number;
  agent: string;
  task: string;
  status: "complete" | "failed" | "running";
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  cost: number | null;
}

interface AcceptanceCheck {
  check: string;
  status: "pass" | "fail" | "warn";
  details: string;
}

interface SessionAnalysis {
  stageRun: StageRunSummary;
  tools: ToolActivity[];
  subagents: SubagentRun[];
}

// --- Paths ---

/** Directory for one E2E run's human-readable artifacts. */
export function e2eRunDir(runId: string): string {
  return path.join(config.artifactsDir, "test-e2e", runId);
}

/** Markdown report path for one E2E run. */
export function e2eReportPath(runId: string): string {
  return path.join(e2eRunDir(runId), "report.md");
}

/** Persist manifest beside report.md under artifacts/test-e2e. */
export async function writeE2eManifest(manifest: E2eManifest): Promise<void> {
  const dir = e2eRunDir(manifest.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// --- Report Writer ---

/** Write the final markdown report and return its path. */
export async function writeE2eReport(input: WriteReportInput): Promise<string> {
  const analyses = await collectAnalyses(input.taskIds);
  const stageRuns = analyses.map((a) => a.stageRun);
  const tools = analyses.flatMap((a) => a.tools);
  const subagents = analyses.flatMap((a) => a.subagents);
  const acceptance = await runAcceptanceChecks(input.manifest.repo, input.taskIds, tools);
  const reportPath = e2eReportPath(input.manifest.runId);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport({ ...input, stageRuns, tools, subagents, acceptance }), "utf8");
  return reportPath;
}

// --- Collection ---

async function collectAnalyses(taskIds: readonly string[]): Promise<SessionAnalysis[]> {
  const nested = await Promise.all(taskIds.map(async (taskId) => {
    const stages = await queries.getStagesForTask(taskId);
    return Promise.all(stages.map((stage) => analyzeStage(taskId, stage)));
  }));
  return nested.flat();
}

async function analyzeStage(taskId: string, stage: TaskStage): Promise<SessionAnalysis> {
  const sessionPath = taskSessionPath(taskId, stage.stage, stage.variant ?? undefined);
  const entries = await readSessionFile(sessionPath);
  const sessionExists = entries.length > 0;
  const stageRun = summarizeStageRun(taskId, stage, sessionPath, entries, sessionExists);
  return {
    stageRun,
    tools: collectToolActivity(stage.stage, stage.variant ?? undefined, entries),
    subagents: collectSubagentRuns(stage.stage, stage.variant ?? undefined, entries),
  };
}

function summarizeStageRun(
  taskId: string,
  stage: TaskStage,
  sessionPath: string,
  entries: FileEntry[],
  sessionExists: boolean,
): StageRunSummary {
  const assistantMessages = messageEntries(entries)
    .map((entry) => entry.message)
    .filter((message): message is AssistantMessage => message.role === "assistant");
  const usage = assistantMessages.reduce((acc, message) => addUsage(acc, message.usage), emptyUsage());
  const latestAssistant = assistantMessages.at(-1);
  const startedAt = stage.startedAt ?? firstEntryDate(entries);
  const completedAt = stage.completedAt ?? lastEntryDate(entries);
  const durationMs = startedAt && completedAt ? Math.max(0, completedAt.getTime() - startedAt.getTime()) : 0;

  return {
    taskId,
    stage: stage.stage,
    variant: stage.variant ?? undefined,
    status: stage.status,
    startedAt,
    completedAt,
    durationMs,
    provider: latestAssistant?.provider ?? "--",
    model: latestAssistant?.model ?? "--",
    stopReasons: assistantMessages.reduce<Record<string, number>>((acc, message) => ({
      ...acc,
      [message.stopReason]: (acc[message.stopReason] ?? 0) + 1,
    }), {}),
    errors: assistantMessages.filter((message) => message.errorMessage).length,
    usage,
    sessionPath,
    sessionExists,
  };
}

function collectToolActivity(stage: StageName, variant: number | undefined, entries: FileEntry[]): ToolActivity[] {
  const calls = new Map<string, ToolCall>();
  const activities: ToolActivity[] = [];

  for (const entry of messageEntries(entries)) {
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.set(block.id, block);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId) ?? fallbackToolCall(message);
      activities.push(toolActivityFromResult(stage, variant, call, message));
      continue;
    }

    if (message.role === "bashExecution") {
      activities.push(toolActivityFromBash(stage, variant, message));
    }
  }

  for (const call of calls.values()) {
    if (!activities.some((activity) => activity.tool === call.name && activity.target === summarizeTarget(call))) {
      activities.push({ stage, variant, tool: call.name, target: summarizeTarget(call), status: "running", details: "no result recorded" });
    }
  }

  return activities;
}

function collectSubagentRuns(stage: StageName, variant: number | undefined, entries: FileEntry[]): SubagentRun[] {
  const planned = new Map<string, ToolCall>();
  const runs: SubagentRun[] = [];

  for (const entry of messageEntries(entries)) {
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "subagent") planned.set(block.id, block);
      }
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
    const call = planned.get(message.toolCallId);
    const fallbackTasks = call ? extractPlannedSubagentTasks(call) : [];
    const details = (message.details ?? {}) as { results?: RawSubagentResult[] };
    const results = details.results ?? [];

    if (results.length === 0) {
      runs.push(...fallbackTasks.map((task) => ({
        parentStage: stage,
        variant,
        agent: task.agent,
        task: task.task,
        status: message.isError ? "failed" as const : "running" as const,
        model: "--",
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        cost: null,
      })));
      continue;
    }

    runs.push(...results.map((result, index) => {
      const fallback = fallbackTasks[index];
      const inputTokens = result.usage?.input ?? 0;
      const outputTokens = result.usage?.output ?? 0;
      const cacheTokens = (result.usage?.cacheRead ?? 0) + (result.usage?.cacheWrite ?? 0);
      const totalTokens = result.progressSummary?.tokens ?? inputTokens + outputTokens + cacheTokens;
      const status: SubagentRun["status"] = result.exitCode === 0 || (!result.error && result.exitCode === undefined) ? "complete" : "failed";
      return {
        parentStage: stage,
        variant,
        agent: result.agent ?? fallback?.agent ?? "?",
        task: trimSingleLine(result.task ?? fallback?.task ?? ""),
        status,
        model: result.model ?? "--",
        durationMs: result.progressSummary?.durationMs ?? result.progress?.durationMs ?? 0,
        inputTokens,
        outputTokens,
        cacheTokens,
        totalTokens,
        cost: result.usage?.cost ?? null,
      };
    }));
  }

  return runs;
}

// --- Acceptance ---

async function runAcceptanceChecks(
  repoName: string,
  taskIds: readonly string[],
  tools: readonly ToolActivity[],
): Promise<AcceptanceCheck[]> {
  const roots = await candidateRepoRoots(repoName, taskIds, tools);
  if (roots.length === 0) return [{ check: "Repo root found", status: "fail", details: `No repo root found for '${repoName}'` }];

  const componentRoot = await firstRootWithFile(roots, FILTER_ATTRIBUTION_COMPONENT);
  const chartRoot = componentRoot ?? await firstRootWithFile(roots, CHART_PAGE);
  const page = chartRoot ? await readFile(path.join(chartRoot, CHART_PAGE), "utf8").catch(() => "") : "";
  const winRateIndex = page.indexOf("<WinRatePanel");
  const attributionIndex = page.indexOf("<FilterAttributionPanel");
  const importsComponent = page.includes("FilterAttributionPanel") && page.includes("filter-attribution-panel");
  const validation = findValidationCommand(tools);

  return [
    {
      check: "Component exists",
      status: componentRoot ? "pass" : "fail",
      details: componentRoot ? path.join(componentRoot, FILTER_ATTRIBUTION_COMPONENT) : FILTER_ATTRIBUTION_COMPONENT,
    },
    {
      check: "Chart page imports component",
      status: importsComponent ? "pass" : "fail",
      details: chartRoot ? path.join(chartRoot, CHART_PAGE) : CHART_PAGE,
    },
    {
      check: "Rendered below WinRatePanel",
      status: winRateIndex >= 0 && attributionIndex > winRateIndex ? "pass" : "fail",
      details: chartRoot ? "WinRatePanel appears before FilterAttributionPanel" : "Chart page not found",
    },
    {
      check: "Build or validation passed",
      status: validation ? "pass" : "warn",
      details: validation ? validation.target : "No successful build/typecheck validation command found in session logs",
    },
  ];
}

async function candidateRepoRoots(
  repoName: string,
  taskIds: readonly string[],
  tools: readonly ToolActivity[],
): Promise<string[]> {
  const roots = new Set<string>();
  const repo = getRepo(repoName);
  if (repo) roots.add(repo.localPath);

  for (const tool of tools) {
    const root = extractCdRoot(tool.target);
    if (root) roots.add(root);
  }

  for (const taskId of taskIds) {
    roots.add(path.join(path.dirname(config.artifactsDir), `goodboy-worktree-${short(taskId)}`));
  }

  const existing = await Promise.all([...roots].map(async (root) => ({ root, exists: await exists(root) })));
  return existing.filter((item) => item.exists).map((item) => item.root);
}

function extractCdRoot(command: string): string | null {
  const match = command.match(/(?:^|\s)cd\s+([^&;\n]+goodboy-worktree-[a-f0-9]+)/);
  return match ? match[1].trim() : null;
}

async function firstRootWithFile(roots: readonly string[], relativePath: string): Promise<string | null> {
  for (const root of roots) {
    if (await exists(path.join(root, relativePath))) return root;
  }
  return null;
}

function findValidationCommand(tools: readonly ToolActivity[]): ToolActivity | null {
  return tools.find((tool) => (
    tool.tool === "bash" &&
    tool.status === "pass" &&
    (
      tool.target.includes("npm run build") ||
      tool.target.includes("tsc") ||
      tool.target.includes("py_compile")
    )
  )) ?? null;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

// --- Render ---

interface RenderInput extends WriteReportInput {
  stageRuns: StageRunSummary[];
  tools: ToolActivity[];
  subagents: SubagentRun[];
  acceptance: AcceptanceCheck[];
}

function renderReport(input: RenderInput): string {
  const totals = input.stageRuns.reduce((acc, stage) => addUsageTotals(acc, stage.usage), emptyUsage());
  const startedAt = new Date(input.manifest.startedAt);
  const completedAt = input.manifest.completedAt ? new Date(input.manifest.completedAt) : new Date();
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  const filesTouched = summarizeFilesTouched(input.tools);
  const failedTools = input.tools.filter((tool) => tool.status === "fail");

  return `${[
    "# Goodboy E2E Report",
    "",
    "## Summary",
    "",
    table([
      ["Field", "Value"],
      ["Result", input.result],
      ["Scenario", input.manifest.runId.split("-")[0] ?? "--"],
      ["Repo", input.manifest.repo],
      ["Owned Task ID", input.manifest.ownedTaskId ?? "--"],
      ["Review Task ID", input.manifest.reviewTaskId ?? "--"],
      ["PR", input.manifest.prUrl ?? "--"],
      ["Started", input.manifest.startedAt],
      ["Completed", input.manifest.completedAt ?? "--"],
      ["Duration", formatDuration(durationMs)],
      ["Total Tokens", formatInteger(totals.totalTokens)],
      ["Total Cost", formatCost(totals.costTotal)],
    ]),
    "",
    "## Acceptance Checks",
    "",
    table([
      ["Check", "Status", "Details"],
      ...input.acceptance.map((check) => [check.check, check.status, check.details]),
    ]),
    "",
    "## Stage Runs",
    "",
    table([
      ["Task", "Stage", "Variant", "Status", "Duration", "Model", "Input Tok", "Output Tok", "Cache Tok", "Total Tok", "Cost", "Session"],
      ...input.stageRuns.map((stage) => [
        short(stage.taskId),
        stage.stage,
        stage.variant === undefined ? "default" : String(stage.variant),
        stage.status,
        formatDuration(stage.durationMs),
        stage.model,
        formatInteger(stage.usage.input),
        formatInteger(stage.usage.output),
        formatInteger(stage.usage.cacheRead + stage.usage.cacheWrite),
        formatInteger(stage.usage.totalTokens),
        formatCost(stage.usage.costTotal),
        stage.sessionExists ? stage.sessionPath : `${stage.sessionPath} (missing)`,
      ]),
    ]),
    "",
    "## Subagent Runs",
    "",
    table([
      ["Parent Stage", "Agent", "Task", "Status", "Model", "Duration", "Input Tok", "Output Tok", "Cache Tok", "Total Tok", "Cost"],
      ...input.subagents.map((run) => [
        formatStage(run.parentStage, run.variant),
        run.agent,
        run.task,
        run.status,
        run.model,
        formatDuration(run.durationMs),
        formatInteger(run.inputTokens),
        formatInteger(run.outputTokens),
        formatInteger(run.cacheTokens),
        formatInteger(run.totalTokens),
        run.cost === null ? "--" : formatCost(run.cost),
      ]),
    ], "No subagent runs recorded."),
    "",
    "## Tool Activity",
    "",
    table([
      ["Stage", "Tool", "Target / Command", "Status", "Details"],
      ...input.tools.map((tool) => [
        formatStage(tool.stage, tool.variant),
        tool.tool,
        tool.target,
        tool.status,
        tool.details,
      ]),
    ], "No tool activity recorded."),
    "",
    "## Files Touched",
    "",
    table([
      ["File", "Operation"],
      ...filesTouched.map((file) => [file.file, file.operation]),
    ], "No file writes or edits recorded."),
    renderFailureContext(input, failedTools),
  ].filter((section) => section.length > 0).join("\n")}\n`;
}

function renderFailureContext(input: RenderInput, failedTools: readonly ToolActivity[]): string {
  if (input.result !== "fail" && failedTools.length === 0) return "";
  const rows = [
    "",
    "## Failure Context",
    "",
  ];

  if (input.error) rows.push(`Top-level error: ${escapeMarkdown(toErrorMessage(input.error))}`, "");
  for (const tool of failedTools) {
    rows.push(`### ${formatStage(tool.stage, tool.variant)} ${tool.tool} failed`, "");
    rows.push(`Target: ${escapeMarkdown(tool.target)}`, "");
    if (tool.outputTail) rows.push("```txt", tool.outputTail, "```", "");
  }

  return rows.join("\n");
}

function table(rows: string[][], emptyText = ""): string {
  if (rows.length <= 1) return emptyText;
  const escaped = rows.map((row) => row.map((cell) => escapeTableCell(cell)));
  const [header, ...body] = escaped;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

// --- Tool Summaries ---

function toolActivityFromResult(
  stage: StageName,
  variant: number | undefined,
  call: ToolCall,
  result: ToolResultMessage,
): ToolActivity {
  const output = joinText(result.content);
  return {
    stage,
    variant,
    tool: result.toolName || call.name,
    target: summarizeTarget(call),
    status: result.isError ? "fail" : "pass",
    details: summarizeResultDetails(call, result, output),
    outputTail: result.isError ? lastLines(output, FAILURE_OUTPUT_LINES) : undefined,
  };
}

function toolActivityFromBash(stage: StageName, variant: number | undefined, message: BashExecutionMessage): ToolActivity {
  return {
    stage,
    variant,
    tool: "bash",
    target: compact(message.command),
    status: message.exitCode === 0 ? "pass" : "fail",
    details: message.exitCode === 0 ? "exit 0" : `exit ${message.exitCode ?? "?"}`,
    outputTail: message.exitCode === 0 ? undefined : lastLines(message.output, FAILURE_OUTPUT_LINES),
  };
}

function summarizeTarget(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "read" || call.name === "edit" || call.name === "write") return compact(String(args.path ?? ""));
  if (call.name === "bash") return compact(String(args.command ?? ""));
  if (call.name === "subagent") return summarizeSubagentCall(call);
  return "";
}

function summarizeResultDetails(call: ToolCall, result: ToolResultMessage, output: string): string {
  if (result.isError) return "failed";
  if (call.name === "read") return `${output.split("\n").filter(Boolean).length} lines`;
  if (call.name === "edit") return "applied";
  if (call.name === "write") return "written";
  if (call.name === "bash") return "exit 0";
  if (call.name === "subagent") return summarizeSubagentResult(result);
  return output ? trimSingleLine(output) : "ok";
}

function summarizeSubagentCall(call: ToolCall): string {
  const tasks = extractPlannedSubagentTasks(call);
  const args = call.arguments ?? {};
  const mode = Array.isArray(args.chain) ? "chain" : Array.isArray(args.tasks) ? "parallel" : typeof args.action === "string" ? args.action : "single";
  return `${mode} (${tasks.length})`;
}

function summarizeSubagentResult(result: ToolResultMessage): string {
  const details = (result.details ?? {}) as { results?: RawSubagentResult[] };
  const results = details.results ?? [];
  if (results.length === 0) return "no worker details";
  const ok = results.filter((worker) => worker.exitCode === 0 || (!worker.error && worker.exitCode === undefined)).length;
  const failed = results.length - ok;
  return `${ok}/${results.length} ok${failed > 0 ? `, ${failed} failed` : ""}`;
}

function fallbackToolCall(message: ToolResultMessage): ToolCall {
  return { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} };
}

// --- Subagent Helpers ---

interface RawSubagentResult {
  agent?: string;
  task?: string;
  exitCode?: number;
  error?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  progress?: { durationMs?: number };
  progressSummary?: { tokens?: number; durationMs?: number };
}

function extractPlannedSubagentTasks(call: ToolCall): Array<{ agent: string; task: string }> {
  const args = call.arguments ?? {};
  if (Array.isArray(args.tasks)) return args.tasks.map(toSubagentTask);
  if (Array.isArray(args.chain)) return args.chain.map(toSubagentTask);
  if (typeof args.agent === "string") return [{ agent: args.agent, task: trimSingleLine(args.task) }];
  return [];
}

function toSubagentTask(value: unknown): { agent: string; task: string } {
  const obj = (value ?? {}) as Record<string, unknown>;
  return { agent: String(obj.agent ?? "?"), task: trimSingleLine(obj.task) };
}

// --- File Summary ---

function summarizeFilesTouched(tools: readonly ToolActivity[]): Array<{ file: string; operation: string }> {
  const touched = new Map<string, Set<string>>();
  for (const tool of tools) {
    if (tool.tool !== "write" && tool.tool !== "edit") continue;
    if (!tool.target) continue;
    const operations = touched.get(tool.target) ?? new Set<string>();
    operations.add(tool.tool === "write" ? "created/overwritten" : "edited");
    touched.set(tool.target, operations);
  }
  return [...touched.entries()].map(([file, operations]) => ({ file, operation: [...operations].join(", ") }));
}

// --- Usage Helpers ---

function addUsage(acc: UsageTotals, usage: Usage): UsageTotals {
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + usage.cacheRead,
    cacheWrite: acc.cacheWrite + usage.cacheWrite,
    totalTokens: acc.totalTokens + usage.totalTokens,
    costInput: acc.costInput + usage.cost.input,
    costOutput: acc.costOutput + usage.cost.output,
    costCacheRead: acc.costCacheRead + usage.cost.cacheRead,
    costCacheWrite: acc.costCacheWrite + usage.cost.cacheWrite,
    costTotal: acc.costTotal + usage.cost.total,
  };
}

function addUsageTotals(acc: UsageTotals, usage: UsageTotals): UsageTotals {
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + usage.cacheRead,
    cacheWrite: acc.cacheWrite + usage.cacheWrite,
    totalTokens: acc.totalTokens + usage.totalTokens,
    costInput: acc.costInput + usage.costInput,
    costOutput: acc.costOutput + usage.costOutput,
    costCacheRead: acc.costCacheRead + usage.costCacheRead,
    costCacheWrite: acc.costCacheWrite + usage.costCacheWrite,
    costTotal: acc.costTotal + usage.costTotal,
  };
}

function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
}

// --- Entry Helpers ---

function messageEntries(entries: FileEntry[]): Array<Extract<SessionEntry, { type: "message" }>> {
  return entries.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message");
}

function firstEntryDate(entries: FileEntry[]): Date | null {
  const first = entries.find((entry) => "timestamp" in entry && typeof entry.timestamp === "string");
  return first && "timestamp" in first ? new Date(first.timestamp) : null;
}

function lastEntryDate(entries: FileEntry[]): Date | null {
  const last = [...entries].reverse().find((entry) => "timestamp" in entry && typeof entry.timestamp === "string");
  return last && "timestamp" in last ? new Date(last.timestamp) : null;
}

function joinText(content: ToolResultMessage["content"]): string {
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

// --- Formatting ---

function formatStage(stage: StageName, variant?: number): string {
  return variant === undefined ? stage : `${stage}#${variant}`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "--";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(4)}` : "$0.00";
}

function trimSingleLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > 160 ? `${single.slice(0, 157)}...` : single;
}

function compact(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > MAX_TARGET_CHARS ? `${single.slice(0, MAX_TARGET_CHARS - 1)}…` : single;
}

function lastLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n");
}

function escapeTableCell(value: string): string {
  return escapeMarkdown(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function escapeMarkdown(value: string): string {
  return value.replace(/`/g, "\\`");
}
