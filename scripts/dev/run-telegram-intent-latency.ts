/**
 * Manual latency probe for the Telegram intent classifier.
 *
 * Edit `MODEL` below to compare different Fireworks models while reusing the
 * exact production prompt and intent schema through `classifyMessageWithModel`.
 */

import "dotenv/config";
import { performance } from "node:perf_hooks";
import { listRepos } from "../../src/shared/domain/repos.js";
import { classifyMessageWithModel } from "../../src/telegram/intent-classifier.js";

const MODEL = "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";
const MESSAGE = "make the graph output for the chart export service animation download a smoother curve with datapoints by taking averages to remove wierd spikes, also remove the legacy support of the run_cycles db table, and instead only use the portfolio_snapshots db table, this is for the coliseum project";

async function run(): Promise<void> {
  const repos = listRepos();
  const startedAt = performance.now();
  const intent = await classifyMessageWithModel(MESSAGE, repos, MODEL);
  const latencyMs = performance.now() - startedAt;

  console.log("=== TELEGRAM INTENT CLASSIFIER LATENCY ===");
  console.log(`model      : ${MODEL}`);
  console.log(`repo count : ${repos.length}`);
  console.log(`latency ms : ${latencyMs.toFixed(2)}`);
  console.log(`message    : ${MESSAGE}`);
  console.log("output     :");
  console.log(JSON.stringify(intent, null, 2));
}

await run();
