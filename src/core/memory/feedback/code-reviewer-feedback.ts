/**
 * Structured human feedback memory for PR reviewer behavior.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createLogger } from "../../../shared/runtime/logger.js";
import { getRepo } from "../../../shared/domain/repos.js";
import { memoryDir } from "../index.js";

const log = createLogger("review-feedback");

export const CODE_REVIEWER_FEEDBACK_FILE = "code_reviewer_feedback.json";

const feedbackStatusSchema = z.enum(["active", "inactive"]);

const feedbackScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("path"), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("review_behavior") }),
]);

const feedbackSourceSchema = z.object({
  type: z.enum(["github_comment", "dashboard_chat"]),
  prNumber: z.number().int().positive(),
  originalText: z.string().min(1),
});

export const codeReviewerFeedbackRuleSchema = z.object({
  id: z.string().regex(/^crf_[a-f0-9]{8}$/),
  status: feedbackStatusSchema,
  title: z.string().min(1),
  rule: z.string().min(1),
  scope: feedbackScopeSchema,
  source: feedbackSourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const codeReviewerFeedbackFileSchema = z.array(codeReviewerFeedbackRuleSchema);

export type CodeReviewerFeedbackRule = z.infer<typeof codeReviewerFeedbackRuleSchema>;
export type CodeReviewerFeedbackScope = z.infer<typeof feedbackScopeSchema>;
export type CodeReviewerFeedbackSource = z.infer<typeof feedbackSourceSchema>;

export interface AppendCodeReviewerFeedbackInput {
  repo: string;
  title: string;
  rule: string;
  scope: CodeReviewerFeedbackScope;
  source: CodeReviewerFeedbackSource;
}

export interface UpdateCodeReviewerFeedbackInput {
  repo: string;
  id: string;
  status?: "active" | "inactive";
  title?: string;
  rule?: string;
  scope?: CodeReviewerFeedbackScope;
}

export type FeedbackListStatus = "active" | "inactive" | "all";

// --- Pure Helpers ---

/** Resolve the canonical feedback file path for a registered repo. */
export function codeReviewerFeedbackPath(repo: string): string {
  return path.join(memoryDir(repo), CODE_REVIEWER_FEEDBACK_FILE);
}

/** Render active feedback rules for prompt injection. */
export function renderCodeReviewerFeedbackBlock(rules: readonly CodeReviewerFeedbackRule[]): string {
  const active = rules.filter((rule) => rule.status === "active");
  if (active.length === 0) return "";

  const groups = [
    { label: "Global", rules: active.filter((rule) => rule.scope.type === "global") },
    { label: "Path", rules: active.filter((rule) => rule.scope.type === "path") },
    { label: "Review behavior", rules: active.filter((rule) => rule.scope.type === "review_behavior") },
  ].filter((group) => group.rules.length > 0);

  const body = groups.map((group) => {
    const lines = group.rules.map((rule) => {
      const scopeSuffix = rule.scope.type === "path" ? ` (${rule.scope.paths.join(", ")})` : "";
      return `- ${rule.id} — ${rule.title}${scopeSuffix}\n  Rule: ${rule.rule}`;
    }).join("\n");
    return `${group.label}:\n${lines}`;
  }).join("\n\n");

  return `CODE REVIEWER FEEDBACK MEMORY:
These active rules are hard requirements learned from human feedback. Follow them when reviewing or editing PR code. If a current explicit human instruction conflicts with a rule, follow the current instruction and call code_reviewer_feedback with action "update" to mark or adjust the old rule if appropriate.

${body}
`;
}

// --- IO ---

/** Create the feedback file if missing, preserving invalid existing files. */
export async function ensureCodeReviewerFeedbackFile(repo: string): Promise<void> {
  assertRegisteredRepo(repo);
  await mkdir(memoryDir(repo), { recursive: true });
  try {
    await readFile(codeReviewerFeedbackPath(repo), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeFile(codeReviewerFeedbackPath(repo), "[]\n", "utf8");
  }
}

/** Read feedback leniently for prompt injection. Invalid files render as no rules. */
export async function readCodeReviewerFeedback(repo: string): Promise<readonly CodeReviewerFeedbackRule[]> {
  await ensureCodeReviewerFeedbackFile(repo);
  const raw = await readFile(codeReviewerFeedbackPath(repo), "utf8");
  try {
    const parsed = codeReviewerFeedbackFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn(`Invalid code reviewer feedback file for ${repo}: ${parsed.error.message}`);
      return [];
    }
    return parsed.data;
  } catch (err) {
    log.warn(`Malformed code reviewer feedback JSON for ${repo}`, err);
    return [];
  }
}

/** Read feedback strictly for mutations so corrupt storage cannot be overwritten. */
export async function readCodeReviewerFeedbackStrict(repo: string): Promise<readonly CodeReviewerFeedbackRule[]> {
  await ensureCodeReviewerFeedbackFile(repo);
  const raw = await readFile(codeReviewerFeedbackPath(repo), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed code reviewer feedback JSON: ${(err as Error).message}`);
  }
  const parsed = codeReviewerFeedbackFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid code reviewer feedback file: ${parsed.error.message}`);
  return parsed.data;
}

/** Append one active, atomic feedback rule. */
export async function appendCodeReviewerFeedback(
  input: AppendCodeReviewerFeedbackInput,
): Promise<CodeReviewerFeedbackRule> {
  const rules = await readCodeReviewerFeedbackStrict(input.repo);
  const now = new Date().toISOString();
  const nextRule: CodeReviewerFeedbackRule = {
    id: generateFeedbackId(rules),
    status: "active",
    title: input.title,
    rule: input.rule,
    scope: input.scope,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  await writeCodeReviewerFeedback(input.repo, [...rules, nextRule]);
  return nextRule;
}

/** Update mutable fields on an existing feedback rule. */
export async function updateCodeReviewerFeedback(
  input: UpdateCodeReviewerFeedbackInput,
): Promise<CodeReviewerFeedbackRule> {
  const rules = await readCodeReviewerFeedbackStrict(input.repo);
  const existing = rules.find((rule) => rule.id === input.id);
  if (!existing) throw new Error(`Unknown code reviewer feedback rule id: ${input.id}`);
  if (!input.status && !input.title && !input.rule && !input.scope) {
    throw new Error("Update requires at least one of status, title, rule, or scope");
  }

  const updated: CodeReviewerFeedbackRule = {
    ...existing,
    ...(input.status ? { status: input.status } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.rule ? { rule: input.rule } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    updatedAt: new Date().toISOString(),
  };
  const nextRules = rules.map((rule) => (rule.id === input.id ? updated : rule));
  await writeCodeReviewerFeedback(input.repo, nextRules);
  return updated;
}

/** List feedback rules by status. */
export async function listCodeReviewerFeedback(
  repo: string,
  status: FeedbackListStatus = "active",
): Promise<readonly CodeReviewerFeedbackRule[]> {
  const rules = await readCodeReviewerFeedback(repo);
  if (status === "all") return rules;
  return rules.filter((rule) => rule.status === status);
}

/** Render active repo feedback rules for an agent prompt. */
export async function codeReviewerFeedbackBlock(repo: string): Promise<string> {
  const rules = await readCodeReviewerFeedback(repo);
  return renderCodeReviewerFeedbackBlock(rules);
}

async function writeCodeReviewerFeedback(
  repo: string,
  rules: readonly CodeReviewerFeedbackRule[],
): Promise<void> {
  const targetPath = codeReviewerFeedbackPath(repo);
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  await rename(tmp, targetPath);
}

function generateFeedbackId(existing: readonly CodeReviewerFeedbackRule[]): string {
  const existingIds = new Set(existing.map((rule) => rule.id));
  while (true) {
    const id = `crf_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!existingIds.has(id)) return id;
  }
}

function assertRegisteredRepo(repo: string): void {
  if (!getRepo(repo)) throw new Error(`Unknown registered repo: ${repo}`);
}
