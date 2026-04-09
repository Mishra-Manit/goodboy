import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_USER_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GH_TOKEN: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  PI_MODEL: z.string().default("openai/gpt-5.4"),
  PORT: z.string().default("3333"),
  HOST: z.string().default("0.0.0.0"),
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
