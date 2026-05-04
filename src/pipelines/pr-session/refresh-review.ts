/**
 * Re-fetch the PR diff + metadata after a session run pushed new commits and
 * overwrite the frozen pr_review snapshots. Best-effort: errors are logged
 * and swallowed so a refresh failure never breaks the underlying turn.
 */

import { writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/runtime/logger.js";
import { parseNwo, getPrDiff, getPrMetadata } from "../../core/git/github.js";
import { getRepoNwo } from "../../shared/domain/repos.js";
import { taskArtifactsDir } from "../../shared/artifacts/index.js";
import { prReviewOutputs } from "../pr-review/output-contracts.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";

const log = createLogger("pr-refresh-review");

export interface RefreshReviewInput {
  prSessionId: string;
  sourceTaskId: string;
  repo: string;
  prNumber: number;
  worktreePath: string;
}

export async function refreshReviewArtifacts(input: RefreshReviewInput): Promise<void> {
  // `input.repo` is the short registry key (e.g. "pantheon") for session-driven callers,
  // but a full GitHub URL for one-off invocations. Try the registry first, fall back to URL.
  const nwo = getRepoNwo(input.repo) ?? parseNwo(input.repo);
  if (!nwo) {
    log.warn(`refreshReviewArtifacts: cannot resolve nwo from ${input.repo}`);
    return;
  }

  const artifactsDir = taskArtifactsDir(input.sourceTaskId);
  const paths = {
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    updatedContext: prReviewOutputs.updatedContext.resolve(artifactsDir, undefined).path,
  };
  try {
    const metadata = await getPrMetadata(nwo, input.prNumber);
    const diff = await getPrDiff(input.worktreePath, metadata.baseRef);
    await writeFile(paths.updatedDiff, diff);
    await writeFile(paths.updatedContext, JSON.stringify(metadata, null, 2));
    log.info(`Refreshed PR review diff for session ${input.prSessionId}`);
  } catch (err) {
    log.warn(`refreshReviewArtifacts failed for ${input.prSessionId}: ${toErrorMessage(err)}`);
  }
}
