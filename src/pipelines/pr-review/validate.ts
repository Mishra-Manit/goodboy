/**
 * Post-run contract checks for the PR analyst stage.
 * Catches silent subagent/report failures before the task is marked complete.
 */

import path from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { prReviewPlanSchema, prReviewReportSchema } from "../../shared/types.js";
import { toErrorMessage } from "../../shared/errors.js";
import { prReviewArtifactPaths, prReviewReportPath } from "./artifacts.js";

// --- Public API ---

/** Validate that the analyst produced the review plan, required reports, and summary. */
export async function validatePrAnalystOutput(
  artifactsDir: string,
): Promise<{ valid: boolean; reason?: string }> {
  const paths = prReviewArtifactPaths(artifactsDir);

  const subagentCallsValid = await validateSubagentCalls(path.join(artifactsDir, "pr_analyst.session.jsonl"));
  if (!subagentCallsValid.valid) {
    return invalid(subagentCallsValid.reason ?? "invalid pr_analyst subagent calls");
  }

  const planResult = await readJsonFile(paths.reviewPlan, prReviewPlanSchema.safeParse);
  if (!planResult.ok) return invalid(planResult.reason);

  const requiredReportIds = [...planResult.value.groups.map((group) => group.id), "holistic"];
  const reportResults = await Promise.all(
    requiredReportIds.map((id) => readJsonFile(prReviewReportPath(artifactsDir, id), prReviewReportSchema.safeParse)),
  );
  const failedReport = reportResults.find((result) => !result.ok);
  if (failedReport && !failedReport.ok) return invalid(failedReport.reason);

  const summaryValid = await hasNonEmptyFile(paths.summary);
  if (!summaryValid.valid) return invalid(summaryValid.reason ?? `${paths.summary} is invalid`);

  return { valid: true };
}

// --- Helpers ---

type ParseResult<T> = { success: true; data: T } | { success: false; error: unknown };
type FileResult<T> = { ok: true; value: T } | { ok: false; reason: string };
type ValidationResult = { valid: true } | { valid: false; reason: string };

async function validateSubagentCalls(sessionPath: string): Promise<ValidationResult> {
  const raw = await readFile(sessionPath, "utf8").catch(() => "");
  const calls = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => findSubagentCalls(line));

  if (calls.length === 0) return { valid: false, reason: "pr_analyst did not call subagents" };

  const invalidCall = calls.find((call) => !isAllowedSubagentCall(call));
  if (invalidCall) return { valid: false, reason: describeInvalidSubagentCall(invalidCall) };

  return { valid: true };
}

function findSubagentCalls(line: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const message = parsed.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  return content.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "toolCall" || entry.name !== "subagent") return [];
    const args = entry.arguments;
    return isRecord(args) ? [args] : [];
  });
}

function isAllowedSubagentCall(args: Record<string, unknown>): boolean {
  if (args.action !== undefined) return false;
  if (args.agentScope !== "project") return false;
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) return false;
  if (args.concurrency !== args.tasks.length) return false;
  return args.tasks.every((task) => isRecord(task) && task.agent === "codebase-explorer");
}

function describeInvalidSubagentCall(args: Record<string, unknown>): string {
  if (args.action !== undefined) return "pr_analyst used subagent action mode instead of project parallel tasks";
  if (args.agentScope !== "project") return "pr_analyst subagent call did not set agentScope=project";
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) return "pr_analyst subagent call was not parallel tasks mode";
  if (args.concurrency !== args.tasks.length) return "pr_analyst subagent concurrency did not match task count";
  return "pr_analyst used a subagent other than project codebase-explorer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => ParseResult<T>,
): Promise<FileResult<T>> {
  try {
    const raw = await readFile(path, "utf8");
    const json: unknown = JSON.parse(raw);
    const parsed = parse(json);
    if (!parsed.success) return { ok: false, reason: `${path} failed schema validation` };
    return { ok: true, value: parsed.data };
  } catch (err) {
    return { ok: false, reason: `${path} is missing or invalid JSON: ${toErrorMessage(err)}` };
  }
}

async function hasNonEmptyFile(path: string): Promise<{ valid: boolean; reason?: string }> {
  try {
    await access(path);
    const info = await stat(path);
    if (info.size <= 0) return { valid: false, reason: `${path} is empty` };
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `${path} is missing: ${toErrorMessage(err)}` };
  }
}

function invalid(reason: string): { valid: boolean; reason: string } {
  return { valid: false, reason };
}
