import { getRegisteredRepos } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import * as queries from "./queries.js";

const log = createLogger("sync-repos");

/**
 * Upserts all repos from REGISTERED_REPOS env var into the database.
 * Each device sets its own local paths in .env, so the DB always
 * reflects the correct paths for the current host.
 */
export async function syncRegisteredRepos(): Promise<void> {
  const repos = getRegisteredRepos();
  const entries = Object.entries(repos);

  if (entries.length === 0) {
    log.warn("No REGISTERED_REPOS configured in .env");
    return;
  }

  for (const [name, { localPath, githubUrl }] of entries) {
    await queries.upsertRepo({ name, localPath, githubUrl });
    log.info(`Synced repo: ${name} -> ${localPath}`);
  }

  log.info(`Synced ${entries.length} repo(s) from REGISTERED_REPOS`);
}
