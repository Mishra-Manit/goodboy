/**
 * Dev-only helper that releases Goodboy's local ownership of a PR session.
 * Keeps the GitHub PR and remote branch intact so PR-review testing can reuse them.
 */

import "dotenv/config";

interface Args {
  readonly repo?: string;
  readonly prNumber?: number;
  readonly sessionId?: string;
  readonly confirm: boolean;
  readonly help: boolean;
}

interface SessionSummary {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number | null;
  readonly mode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly status: string;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

if (!args.confirm) {
  printUsage();
  console.error("\nRefusing to release anything without --confirm.");
  process.exit(1);
}

if (!args.sessionId && (!args.repo || !args.prNumber)) {
  printUsage();
  console.error("\nPass either --session <id> or both --repo <name> --pr <number>.");
  process.exit(1);
}

const queries = await import("../src/db/repository.js");
const { cleanupPrSession } = await import("../src/core/cleanup.js");

const sessions = await queries.listPrSessions();
const matches = findMatches(sessions.map(summarizeSession), args);

if (matches.length === 0) {
  console.log("No active PR session matched the supplied arguments.");
  process.exit(0);
}

if (matches.length > 1) {
  console.error("Multiple active PR sessions matched. Re-run with --session <id>.");
  printSessions(matches);
  process.exit(1);
}

const [session] = matches;
console.log("Releasing PR session locally:");
printSessions([session]);

await cleanupPrSession(session.id);

console.log("\nReleased local PR-session ownership.");
console.log("GitHub PR and remote branch were left untouched.");

function parseArgs(rawArgs: readonly string[]): Args {
  const repo = valueAfter(rawArgs, "--repo");
  const prValue = valueAfter(rawArgs, "--pr");
  const sessionId = valueAfter(rawArgs, "--session");
  const prNumber = prValue ? Number(prValue) : undefined;

  if (prValue && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    console.error(`Invalid --pr value: ${prValue}`);
    process.exit(1);
  }

  return {
    repo,
    prNumber,
    sessionId,
    confirm: rawArgs.includes("--confirm"),
    help: rawArgs.includes("--help") || rawArgs.includes("-h"),
  };
}

function valueAfter(rawArgs: readonly string[], flag: string): string | undefined {
  const index = rawArgs.indexOf(flag);
  if (index === -1) return undefined;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return value;
}

function findMatches(sessions: readonly SessionSummary[], options: Args): SessionSummary[] {
  if (options.sessionId) {
    return sessions.filter((session) => session.id === options.sessionId && session.status === "active");
  }

  return sessions.filter((session) => (
    session.repo === options.repo &&
    session.prNumber === options.prNumber &&
    session.status === "active"
  ));
}

function summarizeSession(session: {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number | null;
  readonly mode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly status: string;
}): SessionSummary {
  return {
    id: session.id,
    repo: session.repo,
    prNumber: session.prNumber,
    mode: session.mode,
    branch: session.branch,
    worktreePath: session.worktreePath,
    status: session.status,
  };
}

function printSessions(sessionsToPrint: readonly SessionSummary[]): void {
  console.table(sessionsToPrint.map((session) => ({
    id: session.id,
    repo: session.repo,
    prNumber: session.prNumber,
    mode: session.mode,
    branch: session.branch,
    worktreePath: session.worktreePath,
    status: session.status,
  })));
}

function printUsage(): void {
  console.log(`Usage:
  npm run dev:release-pr-session -- --repo <repo> --pr <number> --confirm
  npm run dev:release-pr-session -- --session <pr-session-id> --confirm

Examples:
  npm run dev:release-pr-session -- --repo pantheon --pr 3 --confirm
  npm run dev:release-pr-session -- --session 11111111-1111-1111-1111-111111111111 --confirm

This is a dev-only local cleanup helper. It removes Goodboy's worktree/local
branch for the PR session and marks that session closed in Goodboy's DB. It does
not close the GitHub PR and does not delete the remote branch.`);
}
