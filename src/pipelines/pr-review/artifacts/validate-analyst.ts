/**
 * Validates the pr_analyst artifact contract before the pipeline proceeds.
 * Catches partial model compliance: missing plans, skipped subagents, bad JSON.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prReviewPlanSchema, prReviewReportSchema, type PrReviewReport } from "../../../shared/domain/types.js";
import { prReviewArtifactPaths } from "./index.js";

export type AnalystArtifactValidation =
  | { valid: true }
  | { valid: false; reason: string };

const HOLISTIC_REPORT_ID = "holistic";

// --- Public API ---

/** Ensure analyst produced a plan, every expected report, and the posted summary body. */
export async function validatePrAnalystArtifacts(artifactsDir: string): Promise<AnalystArtifactValidation> {
  const paths = prReviewArtifactPaths(artifactsDir);
  const planResult = await readJson(paths.reviewPlan);
  if (!planResult.ok) return { valid: false, reason: `review-plan.json ${planResult.reason}` };

  const parsedPlan = prReviewPlanSchema.safeParse(planResult.value);
  if (!parsedPlan.success) {
    return { valid: false, reason: `review-plan.json failed schema validation: ${parsedPlan.error.message}` };
  }

  const plan = parsedPlan.data;
  const groupIds = plan.groups.map((group) => group.id);
  const uniqueGroupIds = new Set(groupIds);
  if (uniqueGroupIds.size !== groupIds.length) {
    return { valid: false, reason: "review-plan.json contains duplicate group ids" };
  }

  const emptyFocus = plan.groups.find((group) => group.focus.trim().length === 0);
  if (emptyFocus) {
    return { valid: false, reason: `review-plan group ${emptyFocus.id} has empty focus` };
  }

  const summaryResult = await readNonEmptyText(paths.summary);
  if (!summaryResult.ok) return { valid: false, reason: `summary.md ${summaryResult.reason}` };

  await reconcileReportsFromSubagentArtifacts(artifactsDir, paths.reportsDir, [...groupIds, HOLISTIC_REPORT_ID]);

  const reportsDirResult = await listDir(paths.reportsDir);
  if (!reportsDirResult.ok) return { valid: false, reason: `reports directory ${reportsDirResult.reason}` };

  const expectedReportIds = [...groupIds, HOLISTIC_REPORT_ID];
  for (const reportId of expectedReportIds) {
    const reportPath = path.join(paths.reportsDir, `${reportId}.json`);
    const reportResult = await readJson(reportPath);
    if (!reportResult.ok) return { valid: false, reason: `${reportId}.json ${reportResult.reason}` };

    const parsedReport = prReviewReportSchema.safeParse(reportResult.value);
    if (!parsedReport.success) {
      return { valid: false, reason: `${reportId}.json failed schema validation: ${parsedReport.error.message}` };
    }

    if (parsedReport.data.subagent_id !== reportId) {
      return {
        valid: false,
        reason: `${reportId}.json subagent_id mismatch: got ${parsedReport.data.subagent_id}`,
      };
    }
  }

  return { valid: true };
}

// --- Helpers ---

async function readJson(filePath: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const textResult = await readNonEmptyText(filePath);
  if (!textResult.ok) return textResult;

  try {
    return { ok: true, value: JSON.parse(textResult.text) };
  } catch (err) {
    return { ok: false, reason: `is malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readNonEmptyText(filePath: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const text = await readFile(filePath, "utf8");
    if (text.trim().length === 0) return { ok: false, reason: "is empty" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `is missing or unreadable at ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function listDir(dirPath: string): Promise<{ ok: true; entries: string[] } | { ok: false; reason: string }> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) return { ok: false, reason: `is not a directory: ${dirPath}` };
    return { ok: true, entries: await readdir(dirPath) };
  } catch (err) {
    return { ok: false, reason: `is missing or unreadable at ${dirPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface SubagentMeta {
  timestamp?: number;
  artifactPaths?: {
    outputPath?: string;
  };
}

async function reconcileReportsFromSubagentArtifacts(
  artifactsDir: string,
  reportsDir: string,
  expectedReportIds: string[],
): Promise<void> {
  const pendingIds = new Set<string>();
  for (const reportId of expectedReportIds) {
    const reportPath = path.join(reportsDir, `${reportId}.json`);
    const result = await readJson(reportPath);
    if (!result.ok || !prReviewReportSchema.safeParse(result.value).success) {
      pendingIds.add(reportId);
    }
  }
  if (pendingIds.size === 0) return;

  const subagentDir = path.join(artifactsDir, "pr_analyst.session", "subagent-artifacts");
  const subagentList = await listDir(subagentDir);
  if (!subagentList.ok) return;

  const metas: Array<{ timestamp: number; outputPath: string }> = [];
  for (const name of subagentList.entries) {
    if (!name.endsWith("_meta.json")) continue;
    const metaPath = path.join(subagentDir, name);
    const metaResult = await readJson(metaPath);
    if (!metaResult.ok) continue;
    const meta = metaResult.value as SubagentMeta;
    const outputPath = meta.artifactPaths?.outputPath;
    if (!outputPath) continue;
    metas.push({ timestamp: meta.timestamp ?? 0, outputPath });
  }

  metas.sort((a, b) => b.timestamp - a.timestamp);
  if (metas.length === 0) return;

  const recovered = new Map<string, PrReviewReport>();
  for (const meta of metas) {
    const textResult = await readNonEmptyText(meta.outputPath);
    if (!textResult.ok) continue;
    const reportValue = parseLooseJson(textResult.text);
    if (!reportValue) continue;
    const parsed = prReviewReportSchema.safeParse(reportValue);
    if (!parsed.success) continue;
    const report = parsed.data;
    if (!pendingIds.has(report.subagent_id)) continue;
    if (recovered.has(report.subagent_id)) continue;
    recovered.set(report.subagent_id, report);
  }

  if (recovered.size === 0) return;

  await mkdir(reportsDir, { recursive: true });
  for (const [reportId, report] of recovered) {
    const reportPath = path.join(reportsDir, `${reportId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

function parseLooseJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  const slice = trimmed.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}
