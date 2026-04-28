/**
 * Env var parsing + process-wide paths. `loadEnv()` is a lazy singleton so
 * importing this module has no side effects; every consumer goes through
 * the accessor. `config` exposes resolved filesystem paths.
 */

import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Zod schemas ---

const repoEntrySchema = z.object({
  localPath: z.string().min(1),
  githubUrl: z.string().optional(),
  /** Free-form environment notes injected into agent prompts. */
  envNotes: z.string().optional(),
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;

const envSchema = z.object({
  INSTANCE_ID: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_USER_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  GH_TOKEN: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  FIREWORKS_API_KEY: z.string().min(1),
  PI_MODEL: z.string().default("openai/gpt-5.5"),
  PI_MODEL_PLANNER: z.string().optional(),
  PI_MODEL_IMPLEMENTER: z.string().optional(),
  PI_MODEL_REVIEWER: z.string().optional(),
  PI_MODEL_PR_CREATOR: z.string().optional(),
  PI_MODEL_REVISION: z.string().optional(),
  PI_MODEL_MEMORY: z.string().optional(),
  PI_MODEL_PR_IMPACT: z.string().optional(),
  PI_MODEL_PR_ANALYST: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  HOST: z.string().default("0.0.0.0"),

  REGISTERED_REPOS: z.string().default("{}").transform((val, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REGISTERED_REPOS is not valid JSON" });
      return z.NEVER;
    }
    const result = z.record(z.string(), repoEntrySchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `REGISTERED_REPOS shape invalid: ${result.error.message}` });
      return z.NEVER;
    }
    return result.data;
  }),
});

export type Env = z.infer<typeof envSchema>;

type ModelKey = Extract<keyof Env, `PI_MODEL${string}`>;

// --- Public accessors ---

let _env: Env | null = null;

/** Parse and cache `process.env`. Throws on first call if anything is missing or malformed. */
export function loadEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}

/** Resolve a stage-specific model env var with fallback to the global default. */
export function resolveModel(key: ModelKey): string {
  const env = loadEnv();
  return env[key] ?? env.PI_MODEL;
}

/** Test-only. Clears the cached env so the next `loadEnv()` re-parses `process.env`. */
export function resetEnvForTesting(): void {
  _env = null;
}

export const config = {
  artifactsDir: path.resolve(__dirname, "../../artifacts"),
  prSessionsDir: path.resolve(__dirname, "../../data/pr-sessions"),
  piCommand: "pi",
} as const;
