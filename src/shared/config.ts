import { z } from "zod";

const repoEntrySchema = z.object({
  localPath: z.string().min(1),
  githubUrl: z.string().optional(),
});

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_USER_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  GH_TOKEN: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  PI_MODEL: z.string().default("openai/gpt-5.4"),
  PORT: z.string().default("3333"),
  HOST: z.string().default("0.0.0.0"),

  // JSON map of repo name -> { localPath, githubUrl? }
  // Each device sets its own paths in .env
  REGISTERED_REPOS: z.string().default("{}").transform((val) => {
    const parsed = JSON.parse(val);
    return z.record(z.string(), repoEntrySchema).parse(parsed);
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
  artifactsDir: "artifacts",
  piCommand: "pi",
} as const;

export function getPiModel(): string {
  return loadEnv().PI_MODEL;
}

export function getRegisteredRepos(): Record<string, z.infer<typeof repoEntrySchema>> {
  return loadEnv().REGISTERED_REPOS;
}
