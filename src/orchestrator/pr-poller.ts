import { createLogger } from "../shared/logger.js";

const log = createLogger("pr-poller");

let started = false;

export function startPrPoller(): void {
  if (started) return;

  started = true;
  log.info("PR poller is currently stubbed and does not run any background polling");
}

export function stopPrPoller(): void {
  if (!started) return;

  started = false;
  log.info("PR poller stub stopped");
}
