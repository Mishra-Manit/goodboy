import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@dashboard": path.resolve(__dirname, "dashboard/src"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "dashboard/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    setupFiles: ["tests/setup/env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/**/*.ts",
        "dashboard/src/components/log-viewer/helpers.ts",
        "dashboard/src/lib/format.ts",
        "dashboard/src/lib/task-grouping.ts",
        "dashboard/src/lib/utils.ts",
      ],
      exclude: [
        "src/core/pi/**",
        "src/core/stage.ts",
        "src/pipelines/**/pipeline.ts",
        "src/pipelines/pr-session/session.ts",
        "src/pipelines/pr-session/poller.ts",
        "src/db/queries.ts",
        "src/db/schema.ts",
        "src/db/index.ts",
        "src/index.ts",
        "**/*.test.ts",
      ],
    },
  },
});
