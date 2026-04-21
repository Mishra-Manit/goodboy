/**
 * One-shot Logfire initialization. Called from src/index.ts before any
 * pipeline boots. `configure()` is idempotent but we guard anyway so
 * hot-reload in dev doesn't double-register span processors.
 *
 * Graceful shutdown is critical: BatchSpanProcessor keeps spans in memory
 * and will drop them on SIGTERM unless we forceFlush + shutdown first.
 */

import * as logfire from "@pydantic/logfire-node";
import { trace } from "@opentelemetry/api";
import { loadEnv } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("observability");

let _initialized = false;

export function initObservability(): void {
  if (_initialized) return;
  const env = loadEnv();
  const token = process.env.LOGFIRE_TOKEN;
  logfire.configure({
    token,
    sendToLogfire: "if-token-present",
    serviceName: "goodboy",
    environment: env.INSTANCE_ID,
    distributedTracing: false,
  });
  _initialized = true;
  log.info(
    token
      ? `Logfire enabled (environment=${env.INSTANCE_ID})`
      : "LOGFIRE_TOKEN unset; spans will be dropped",
  );
}

/** Flush and shut down the OTel provider. Call from SIGINT/SIGTERM. */
export async function shutdownObservability(): Promise<void> {
  if (!_initialized) return;
  const provider = trace.getTracerProvider() as unknown as {
    forceFlush?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  };
  try {
    await provider.forceFlush?.();
  } catch (err) {
    log.warn(`forceFlush failed: ${String(err)}`);
  }
  try {
    await provider.shutdown?.();
  } catch (err) {
    log.warn(`shutdown failed: ${String(err)}`);
  }
}
