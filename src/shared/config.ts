import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoEntrySchema = z.object({
  localPath: z.string().min(1),
  githubUrl: z.string().optional(),
  /** Free-form environment notes injected into agent prompts */
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
  PI_MODEL: z.string().default("openai/gpt-5.4"),
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

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}

export const config = {
  maxParallelTasks: 2,
  artifactsDir: path.resolve(__dirname, "../../artifacts"),
  piCommand: "pi",
} as const;
