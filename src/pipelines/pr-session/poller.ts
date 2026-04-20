import { createLogger } from "../../shared/logger.js";
import { getRepo } from "../../shared/repos.js";
import * as queries from "../../db/queries.js";
import {
  getPrComments,
  getPrReviewComments,
  isPrClosed,
  parseNwo,
} from "../../core/github.js";
import { resumePrSession } from "./session.js";
import { cleanupPrSession } from "../cleanup.js";
import type { SendTelegram } from "../../core/stage.js";

const log = createLogger("pr-poller");

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** Sessions currently being resumed -- prevents double-processing. */
const inFlight = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;

export function startPrPoller(sendTelegram: SendTelegram): void {
  if (timer) return;

  log.info("PR poller started");

  async function pollOnce(): Promise<void> {
    const sessions = await queries.listActivePrSessions();

    for (const session of sessions) {
      // Skip sessions without a PR (PR not created yet)
      if (!session.prNumber) continue;

      // Skip sessions currently being processed
      if (inFlight.has(session.id)) continue;

      const repo = getRepo(session.repo);
      if (!repo?.githubUrl) {
        log.warn(`Repo '${session.repo}' missing githubUrl, skipping poll`);
        continue;
      }

      const nwo = parseNwo(repo.githubUrl);
      if (!nwo) continue;

      // Check if PR is still open
      const closed = await isPrClosed(nwo, session.prNumber);
      if (closed) {
        log.info(`PR #${session.prNumber} on ${nwo} is closed, cleaning up session ${session.id}`);
        await cleanupPrSession(session.id);
        continue;
      }

      // Fetch both comment types
      const issueComments = await getPrComments(nwo, session.prNumber);
      const reviewComments = await getPrReviewComments(nwo, session.prNumber);
      const allComments = [...issueComments, ...reviewComments];

      // Filter to new comments since last poll
      const newComments = allComments.filter((c) =>
        !session.lastPolledAt || new Date(c.createdAt) > session.lastPolledAt
      );

      // Filter out bot comments (gh actions, our own bot, etc.)
      const humanComments = newComments.filter((c) =>
        !c.author.endsWith("[bot]") && c.author !== "github-actions"
      );

      if (humanComments.length === 0) {
        await queries.updatePrSession(session.id, { lastPolledAt: new Date() });
        continue;
      }

      log.info(`Found ${humanComments.length} new comments on PR #${session.prNumber}`);

      inFlight.add(session.id);
      try {
        await resumePrSession({
          prSessionId: session.id,
          comments: humanComments,
          sendTelegram,
        });
      } catch (err) {
        log.error(`Failed to resume PR session ${session.id}`, err);
      } finally {
        inFlight.delete(session.id);
      }
    }
  }

  // Run first poll after a short delay, then on interval
  setTimeout(() => {
    pollOnce().catch((err) => log.error("Initial poll cycle failed", err));
  }, 10_000);

  timer = setInterval(() => {
    pollOnce().catch((err) => log.error("Poll cycle failed", err));
  }, POLL_INTERVAL_MS);
}

export function stopPrPoller(): void {
  if (!timer) return;

  clearInterval(timer);
  timer = null;
  log.info("PR poller stopped");
}

