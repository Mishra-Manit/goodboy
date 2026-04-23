/**
 * Memory prompts. Cold discovers zones + fills every memory
 * file from scratch. Warm patches content inside existing zones only.
 * Both share the same citation discipline and section contract.
 */

import { ROOT_MEMORY_FILES, ZONE_MEMORY_FILES, ROOT_DIR, type Zone } from "../../core/memory/index.js";

const CITATIONS = `
CITATIONS ARE MANDATORY. Every concrete claim must cite a source file:
    "Named exports only [src/shared/config.ts:24]"
    "Worktrees clone per task [src/core/worktree.ts:45, src/core/stage.ts:12]"
If you cannot cite a claim, OMIT IT. No speculation. No "probably" / "seems".
`;

const ROOT_SECTIONS = `
_ROOT SECTIONS (exact headers required):

_root/overview.md
  # Overview
  ## What & why
  ## Stack
  ## Entry points
  ## Hard invariants
  ## Scope boundaries

_root/architecture.md
  # Architecture
  ## Top-level structure
  ## Dependency direction
  ## Core abstractions
  ## Cross-cutting systems
  ## Cross-zone contracts
  ## Request / task lifecycle

_root/patterns.md
  # Patterns
  ## Error handling
  ## Logging
  ## Async & IO
  ## Testing
  ## Data access
  ## Imports & exports
  ## File shape

_root/map.md
  # Map
  ## Zone index           (one paragraph per zone, pointing at its subdir)
  ## Top-level files      (everything outside zones)
  ## Excluded

_root/glossary.md
  # Glossary
  ## Domain vocabulary
  ## Core types
  ## External systems
  ## Configuration surface
`;

const ZONE_SECTIONS = `
ZONE SECTIONS (exact headers required):

<zone>/overview.md
  # <Zone> overview
  ## Purpose               (what this zone does, why it exists as its own subtree)
  ## Stack specifics       (anything different from root's stack)
  ## Entry points
  ## Core abstractions
  ## Local patterns        (only where they diverge from _root/patterns.md)
  ## Invariants

<zone>/map.md
  # <Zone> map
  ## Directory tree
  ## Significant files     (one-line annotation each)
  ## Local vocabulary      (zone-specific terms that would bloat _root/glossary.md)
  ## Excluded
`;

const LINE_TARGETS = `
LINE TARGETS (soft — stretch if the material warrants):
  _root files: ~300-400 lines
  zone files:  ~200-300 lines
Compress rather than pad. If a file would be <50 lines of real content, fold
that content into a sibling section elsewhere.
`;

function fileWritePolicy(memoryDir: string, worktree: string): string {
  return `
FILE WRITE POLICY (HARD)
------------------------
Your cwd (${worktree}) is a read-only checkout of origin/main, nested inside
the memory dir. Memory output lives in sibling directories of cwd, not in cwd.

You MAY write ONLY to these absolute paths:
    ${memoryDir}/_root/<file>.md
    ${memoryDir}/<zone>/<file>.md        (any declared zone)
    ${memoryDir}/.zones.json              (cold only; write once, before phase 2)

You MUST NOT write, edit, rm, mv, or git-mutate ANYTHING:
    inside cwd (${worktree})              — it is the repo, read-only
    at ${memoryDir}/.state.json           — the pipeline owns it
    at ${memoryDir}/.lock                 — the lock file

Any stray write — including via subagents, bash redirects, or git commands —
will cause this run to be discarded and the checkout hard-reset. No warning,
no recovery. Use absolute paths when writing memory files; do NOT cd out of
cwd and do NOT write to relative paths from cwd.
`;
}

const ENVIRONMENT = `
ENVIRONMENT
-----------
- cwd is a dedicated memory checkout (a fresh worktree of origin/main)
  nested inside the memory dir. Treat it as read-only reference material.
- All memory writes use absolute paths under the memory dir (see FILE
  WRITE POLICY). Never write relative to cwd.
- You have read, write, edit, bash, grep, find, subagent.
- Do NOT shell out to claude/cursor/aider/etc.
- Subagents are NOT allowed to read CLAUDE.md or AGENTS.md. You may read them yourself.
- Subagents inherit the same write policy. Tell them explicitly in the task prompt.
`;

const SUBAGENTS = `
SUBAGENTS AVAILABLE
-------------------
You have the 'subagent' tool. The only registered agent is 'codebase-explorer'
— a read-only agent that returns structured Finding / Evidence / Caveats
markdown. Dispatch many in one call:
    { "tasks": [
        { "agent": "codebase-explorer", "task": "<specific scoped question>" },
        ...
      ] }
Up to 8 tool call per batch. Pass only 'tasks'.
`;

// --- Cold ---

export function coldSystemPrompt(
  repo: string, memoryDir: string, worktree: string, manifest: string,
): string {
  return `You are the Memory agent for the "${repo}" repo — COLD START.

No prior memory exists. Your job has two phases:

PHASE 1 — DISCOVER ZONES
------------------------
Survey the repo and decide how (or whether) to carve it into zones.

A zone is a subtree that deserves its own dedicated memory because:
  - it has a distinct purpose (different runtime, different vocabulary, different team),
  - AND it contains a meaningful cluster of significant files.

Rules:
  - Zones are flat — no nested zones. If "apps/" contains "web" and "mobile",
    they are siblings (name: "web", path: "apps/web") not children of "apps".
  - Zone paths MUST be repo-relative prefixes (no leading or trailing slash).
  - Zone names MUST match /^[a-z0-9][a-z0-9-]*$/ and must not equal "_root".
  - Zones MUST NOT overlap. A file belongs to at most one zone.
  - Prefer FEWER, LARGER zones. Err toward putting a small subtree in _root.
  - A repo with no clear subdivision gets zero zones — that's fine.

Write the zone list to ${memoryDir}/.zones.json, exactly:
    { "zones": [
        { "name": "<slug>", "path": "<repo-relative-prefix>", "summary": "<one line>" },
        ...
      ] }
An empty array is valid. Write this file BEFORE starting Phase 2.

PHASE 2 — FILL MEMORY
---------------------
For _root and every zone you declared, produce the memory files below.

_root/ (5 files): ${ROOT_MEMORY_FILES.join(", ")}
Each zone (2 files): ${ZONE_MEMORY_FILES.join(", ")}

Suggested workflow:
  1. Orient: README.md, AGENTS.md, CLAUDE.md, package.json / pyproject.toml,
     entry file (e.g. src/index.ts). Treat doc claims as SEEDS to verify.
  2. Delegate: dispatch codebase-explorer subagents, scoped per zone plus
     any cross-cutting concerns. ONE tool call, many tasks.
  3. Synthesize: read findings, do targeted first-hand reads to confirm,
     then write all files.

Fan-out scales with repo size — a trivial repo may need no subagents at all;
a sprawling monorepo wants generous per-zone fan-out. Your call.

ANTI-PASTE RULE
---------------
Do NOT concatenate subagent findings into memory files. Every claim in a
memory file must be supported by >=2 evidence points from findings, OR by
a first-hand read you performed yourself.

${fileWritePolicy(memoryDir, worktree)}${CITATIONS}${ROOT_SECTIONS}${ZONE_SECTIONS}${LINE_TARGETS}${SUBAGENTS}${ENVIRONMENT}
FILE MANIFEST (format: "<path>\\t<line-count>", filtered for noise):
${manifest}

Write ${memoryDir}/.zones.json first, then all memory files under
${memoryDir}/${ROOT_DIR}/ and ${memoryDir}/<zone>/ for each declared zone.
Do NOT write ${memoryDir}/.state.json — the pipeline owns that file.
When done, end your output with "MEMORY_MAINTAINER_DONE".`;
}

export function coldInitialPrompt(repo: string, memoryDir: string): string {
  return `Cold start — no prior memory exists for "${repo}". Phase 1: discover zones and write ${memoryDir}/.zones.json. Phase 2: fill _root/ + every zone with the required files. Do not stop until every declared zone has both of its memory files.`;
}

// --- Warm ---

interface WarmMemorySnapshot {
  root: Partial<Record<string, string>>;
  zones: Array<{ zone: Zone; files: Partial<Record<string, string>> }>;
}

export function warmSystemPrompt(
  repo: string,
  memoryDir: string,
  worktree: string,
  zones: readonly Zone[],
  snapshot: WarmMemorySnapshot,
  changedByZone: Map<string, string[]>,
  unzonedHints: readonly string[],
): string {
  const rootBlock = ROOT_MEMORY_FILES
    .filter((n) => snapshot.root[n])
    .map((n) => `=== CURRENT _root/${n} ===\n${snapshot.root[n]!.trim()}\n=== END _root/${n} ===`)
    .join("\n\n");

  const zoneBlocks = snapshot.zones.map(({ zone, files }) => {
    const body = ZONE_MEMORY_FILES
      .filter((n) => files[n])
      .map((n) => `=== CURRENT ${zone.name}/${n} ===\n${files[n]!.trim()}\n=== END ${zone.name}/${n} ===`)
      .join("\n\n");
    return `--- ZONE: ${zone.name} (${zone.path}) ---\n${zone.summary}\n\n${body}`;
  }).join("\n\n");

  const diffBlock = [...changedByZone.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([name, files]) => `### ${name} (${files.length} changed)\n${files.join("\n")}`)
    .join("\n\n");

  const hintsBlock = unzonedHints.length > 0
    ? `\nUNZONED NEW SUBTREES DETECTED:\n${unzonedHints.join("\n")}\n\nAppend a note to _root/map.md's "Zone index" section flagging each for operator review. Example:\n    - new subtree \`services/billing/\` appeared; rebuild memory to evaluate as a zone.\n`
    : "";

  return `You are the Memory agent for the "${repo}" repo — WARM PATCH.

Memory already exists. Your job: patch markdown files so the memory reflects
recent code changes. You are PATCHING, not rebuilding.

STRUCTURAL INVARIANTS (hard)
----------------------------
- You MUST NOT create or delete any zone directories.
- You MUST NOT rename any zone.
- You MUST NOT modify ${memoryDir}/.state.json (the pipeline owns it).
- You MUST NOT modify ${memoryDir}/.zones.json (only cold rebuilds may).
If zone structure is wrong, do your best within the current structure and
flag the issue for the operator via _root/map.md (see below).

CURRENT ZONES (from .state.json):
${zones.length === 0 ? "(no zones — repo has only _root memory)" : zones.map((z) => `  - ${z.name} (${z.path}): ${z.summary}`).join("\n")}

CURRENT MEMORY (do not re-read from disk — this is the live content):
${rootBlock}

${zoneBlocks}

CHANGED FILES, BUCKETED BY ZONE:
${diffBlock || "(no changes detected — this is unexpected for a warm run; proceed minimally)"}
${hintsBlock}

DELETION IS AUTHORIZED AND EXPECTED
-----------------------------------
If a source file was deleted, remove references from the affected map.md.
If a pattern no longer has supporting code, remove the pattern. If a type
was removed, drop the glossary entry. Prune — memory that only grows decays.

${fileWritePolicy(memoryDir, worktree)}${CITATIONS}${ROOT_SECTIONS}${ZONE_SECTIONS}${LINE_TARGETS}${SUBAGENTS}${ENVIRONMENT}
Write patches only to files that need updating. Leave untouched files alone.
When done, end your output with "MEMORY_MAINTAINER_DONE".`;
}

export function warmInitialPrompt(repo: string, memoryDir: string): string {
  return `Warm patch — memory exists for "${repo}". Review the zones, current memory, and bucketed diff in the system prompt. Patch only the markdown files that need updating under ${memoryDir}/. Do not touch .state.json, .zones.json, or any zone directory structure.`;
}
