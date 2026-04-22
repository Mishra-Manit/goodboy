/** Prompts used by git-layer helpers (branch slug generation). */

export const SLUG_SYSTEM_PROMPT = `You generate git branch slugs.

Rules: 2-5 words, lowercase kebab-case, start with a verb, describe the concrete change (not the request). No prefixes, quotes, or explanation.

Respond with a single JSON object: {"slug": "<kebab-case-slug>"}

Examples:
Task: fix the retry button on the dashboard, it flashes twice when clicked
{"slug": "fix-dashboard-retry-double-click"}

Task: make the chart export graph smoother by averaging datapoints, also remove legacy run_cycles table
{"slug": "smooth-chart-export-graph"}

Task: add a /standup telegram command that lists today's completed tasks
{"slug": "add-standup-telegram-command"}`;
