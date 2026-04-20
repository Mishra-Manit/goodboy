/**
 * Periodic poller that watches every active PR session for new human
 * comments, closes finished sessions, and resumes the owning pi session to
 * address feedback. Runs on a 3-minute tick; skips sessions already in flight.
 */

import { createLogger } from "../../shared/logger.js";
import { getRepoNwo } from "../../shared/repos.js";
import * as queries from "../../db/queries.js";
import type { PrSession } from "../../db/queries.js";
import {
  getPrComments,
  getPrReviewComments,
  isPrClosed,
  type PrComment,
} from "../../core/github.js";
import { resumePrSession } from "./session.js";
import { cleanupPrSession } from "../cleanup.js";
import type { SendTelegram } from "../../core/stage.js";

const log = createLogger("pr-poller");

const POLL_INTERVAL_MS = 3 * 60 * 1000;
const INITIAL_DELAY_MS = 10_000;

// Sessions currently being resumed; guards against double-processing.
const inFlight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

// --- Public API ---

/** Start the poller. Idempotent; safe to call multiple times. */
export function startPrPoller(sendTelegram: SendTelegram): void {
  if (timer) return;
  log.info("PR poller started");

  const tick = () => pollOnce(sendTelegram).catch((err) => log.error("Poll cycle failed", err));
  setTimeout(tick, INITIAL_DELAY_MS);
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

/** Stop the poller. Idempotent. */
export function stopPrPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info("PR poller stopped");
}

// --- Poll cycle ---

async function pollOnce(sendTelegram: SendTelegram): Promise<void> {
  const sessions = await queries.listActivePrSessions();
  for (const session of sessions) {
    await processSession(session, sendTelegram);
  }
}

async function processSession(session: PrSession, sendTelegram: SendTelegram): Promise<void> {
  if (!session.prNumber || inFlight.has(session.id)) return;

  const nwo = getRepoNwo(session.repo);
  if (!nwo) {
    log.warn(`Repo '${session.repo}' missing githubUrl or not registered; skipping poll`);
    return;
  }

  if (await isPrClosed(nwo, session.prNumber)) {
    log.info(`PR #${session.prNumber} on ${nwo} is closed; cleaning up session ${session.id}`);
    await cleanupPrSession(session.id);
    return;
  }

  const comments = await fetchNewHumanComments(nwo, session);
  if (comments.length === 0) {
    await queries.updatePrSession(session.id, { lastPolledAt: new Date() });
    return;
  }

  log.info(`Found ${comments.length} new comments on PR #${session.prNumber}`);
  inFlight.add(session.id);
  try {
    await resumePrSession({ prSessionId: session.id, comments, sendTelegram });
  } catch (err) {
    log.error(`Failed to resume PR session ${session.id}`, err);
  } finally {
    inFlight.delete(session.id);
  }
}

// --- Comment fetching + filtering ---

async function fetchNewHumanComments(nwo: string, session: PrSession): Promise<PrComment[]> {
  const [issue, review] = await Promise.all([
    getPrComments(nwo, session.prNumber!),
    getPrReviewComments(nwo, session.prNumber!),
  ]);
  return [...issue, ...review].filter((c) => isNew(c, session.lastPolledAt) && isHuman(c));
}

function isNew(comment: PrComment, lastPolledAt: Date | null): boolean {
  return !lastPolledAt || new Date(comment.createdAt) > lastPolledAt;
}

function isHuman(comment: PrComment): boolean {
  return !comment.author.endsWith("[bot]") && comment.author !== "github-actions";
}
