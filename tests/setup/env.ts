/**
 * Stubs every env var required by `envSchema` in `src/shared/config.ts` so
 * `loadEnv()` succeeds inside tests without a real `.env`. Registered via
 * `setupFiles` in `vitest.config.ts`; runs before any test module loads.
 */

process.env.INSTANCE_ID ??= "test";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_USER_ID ??= "1";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.GH_TOKEN ??= "test-gh-token";
process.env.FIREWORKS_API_KEY ??= "test-fireworks-key";
process.env.REGISTERED_REPOS ??= JSON.stringify({
  myrepo: { localPath: "/tmp/myrepo", githubUrl: "https://github.com/test/myrepo" },
  other: { localPath: "/tmp/other", githubUrl: "https://github.com/test/other.git" },
});
