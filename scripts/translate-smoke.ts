/** Read a real pi session JSONL, fold through translate(), print commands. */
import { readFileSync } from "node:fs";
import { translate, initialState } from "../src/observability/bridge/translate.js";
import type { FileEntry } from "../src/shared/session.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/translate-smoke.ts <session.jsonl>");
  process.exit(1);
}

const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
let state = initialState();
let chatStarts = 0;
let chatEnds = 0;
let toolStarts = 0;
let toolEnds = 0;
let totalCost = 0;
let totalIn = 0;
let totalOut = 0;

for (const line of lines) {
  let entry: FileEntry;
  try { entry = JSON.parse(line); } catch { continue; }
  const out = translate(state, entry);
  state = out.state;
  for (const cmd of out.commands) {
    if (cmd.type === "chat.start") chatStarts++;
    if (cmd.type === "chat.end") {
      chatEnds++;
      totalIn += cmd.usage.inputTokens;
      totalOut += cmd.usage.outputTokens;
    }
    if (cmd.type === "tool.start") toolStarts++;
    if (cmd.type === "tool.end") toolEnds++;
    if (cmd.type === "cost.add") totalCost += cmd.usd;
  }
}

console.log(`Entries processed: ${lines.length}`);
console.log(`Chat spans:  start=${chatStarts} end=${chatEnds}`);
console.log(`Tool spans:  start=${toolStarts} end=${toolEnds} (open=${state.toolToChat.size})`);
console.log(`Pending chat ends: ${state.pendingChatEnds.size}`);
console.log(`Tokens:      in=${totalIn} out=${totalOut}`);
console.log(`Cost:        $${totalCost.toFixed(4)}`);
