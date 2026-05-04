/**
 * Shared contract primitives for files and final responses produced by pi agents.
 * Pipelines declare outputs once; prompts, validation, and dashboard metadata derive from these contracts.
 */

import { z } from "zod";

export type OutputPolicy = "required" | "optional" | "softRequired";
export type FileOutputKind = "text" | "json";

export interface DashboardArtifactMeta {
  readonly key: string;
  readonly label: string;
}

export interface PromptContractMeta {
  readonly name: string;
  readonly instructions?: string;
  readonly skeleton?: string;
}

export interface ResolvedFileOutputContract<T = unknown> {
  readonly id: string;
  readonly kind: FileOutputKind;
  readonly policy: OutputPolicy;
  readonly path: string;
  readonly dashboard?: DashboardArtifactMeta;
  readonly prompt: PromptContractMeta;
  readonly schema?: z.ZodType<T>;
}

export interface FileOutputContract<T = unknown, Params = void> {
  readonly id: string;
  readonly kind: FileOutputKind;
  readonly policy: OutputPolicy;
  readonly relativePath: (params: Params) => string;
  readonly dashboard?: (params: Params) => DashboardArtifactMeta | undefined;
  readonly prompt: PromptContractMeta;
  readonly schema?: z.ZodType<T>;
  readonly resolve: (rootDir: string, params: Params) => ResolvedFileOutputContract<T>;
}

export interface FinalResponseContract<T = unknown> {
  readonly id: string;
  readonly schema: z.ZodType<T>;
  readonly description: string;
  readonly example: string;
}

export const stageCompleteFinalResponseSchema = z.object({
  status: z.literal("complete"),
}).strict();

export const prCreationFinalResponseSchema = z.object({
  status: z.literal("complete"),
  prUrl: z.string().url().regex(
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/,
    "must be a GitHub pull request URL",
  ),
}).strict();

export const reviewChatFinalResponseSchema = z.object({
  status: z.enum(["complete", "failed"]),
  changed: z.boolean(),
}).strict();

export type StageCompleteFinalResponse = z.infer<typeof stageCompleteFinalResponseSchema>;
export type PrCreationFinalResponse = z.infer<typeof prCreationFinalResponseSchema>;
export type ReviewChatFinalResponse = z.infer<typeof reviewChatFinalResponseSchema>;

export const stageCompleteFinalResponseContract: FinalResponseContract<StageCompleteFinalResponse> = {
  id: "stage.complete",
  schema: stageCompleteFinalResponseSchema,
  description: "Default non-chat stage completion marker.",
  example: '{"status":"complete"}',
};

export const prCreationFinalResponseContract: FinalResponseContract<PrCreationFinalResponse> = {
  id: "pr_session.creation",
  schema: prCreationFinalResponseSchema,
  description: "PR creation completion marker with the GitHub pull request URL created in this turn.",
  example: '{"status":"complete","prUrl":"https://github.com/OWNER/REPO/pull/123"}',
};

export const reviewChatFinalResponseContract: FinalResponseContract<ReviewChatFinalResponse> = {
  id: "pr_session.review_chat",
  schema: reviewChatFinalResponseSchema,
  description: "Review-chat final-line marker indicating whether code changed.",
  example: '{"status":"complete","changed":false}',
};

export function defineTextOutput<Params = void>(options: {
  id: string;
  policy?: OutputPolicy;
  path: (params: Params) => string;
  prompt: PromptContractMeta;
  dashboard?: (params: Params) => DashboardArtifactMeta | undefined;
}): FileOutputContract<string, Params> {
  return buildContract({ ...options, kind: "text", schema: undefined });
}

export function defineJsonOutput<TSchema extends z.ZodTypeAny, Params = void>(options: {
  id: string;
  policy?: OutputPolicy;
  path: (params: Params) => string;
  schema: TSchema;
  prompt: PromptContractMeta;
  dashboard?: (params: Params) => DashboardArtifactMeta | undefined;
}): FileOutputContract<z.infer<TSchema>, Params> {
  return buildContract({ ...options, kind: "json" });
}

function buildContract<T, Params>(options: {
  id: string;
  kind: FileOutputKind;
  policy?: OutputPolicy;
  path: (params: Params) => string;
  schema?: z.ZodType<T>;
  prompt: PromptContractMeta;
  dashboard?: (params: Params) => DashboardArtifactMeta | undefined;
}): FileOutputContract<T, Params> {
  return {
    id: options.id,
    kind: options.kind,
    policy: options.policy ?? "required",
    relativePath: options.path,
    dashboard: options.dashboard,
    prompt: options.prompt,
    schema: options.schema,
    resolve(rootDir, params) {
      return {
        id: options.id,
        kind: options.kind,
        policy: options.policy ?? "required",
        path: joinPath(rootDir, options.path(params)),
        dashboard: options.dashboard?.(params),
        prompt: options.prompt,
        ...(options.schema ? { schema: options.schema } : {}),
      };
    },
  };
}

function joinPath(rootDir: string, relativePath: string): string {
  // Contract paths are logical artifact paths: rootDir is absolute in production,
  // and relativePath must be a simple forward-slash relative path without `..`.
  if (relativePath.split("/").includes("..")) throw new Error(`Invalid output path: ${relativePath}`);
  if (rootDir.length === 0) return relativePath;
  if (relativePath.length === 0) return rootDir;
  return `${rootDir.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}
