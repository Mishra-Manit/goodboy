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
let _flushTimer: ReturnType<typeof setInterval> | null = null;

/** Spans close as pi writes; without this, live view lags ~5s behind reality. */
const FLUSH_INTERVAL_MS = 2000;

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
    // Disable the default node auto-instrumentations. We don't want undici /
    // fs / dns spans flooding Logfire -- the only thing we want to see is
    // the agent tree emitted by our bridge + the manual pipeline/stage spans.
    nodeAutoInstrumentations: {
      "@opentelemetry/instrumentation-undici": { enabled: false },
      "@opentelemetry/instrumentation-http": { enabled: false },
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    },
  });
  _initialized = true;
  log.info(
    token
      ? `Logfire enabled (environment=${env.INSTANCE_ID})`
      : "LOGFIRE_TOKEN unset; spans will be dropped",
  );

  if (token) {
    _flushTimer = setInterval(() => {
      const provider = trace.getTracerProvider() as unknown as {
        forceFlush?: () => Promise<void>;
      };
      provider.forceFlush?.().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    _flushTimer.unref?.();
  }
}

/** Flush and shut down the OTel provider. Call from SIGINT/SIGTERM. */
export async function shutdownObservability(): Promise<void> {
  if (!_initialized) return;
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
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
