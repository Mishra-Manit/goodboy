/** Pure GitHub URL and PR identifier parsers shared across backend layers. */

/** Extract "owner/repo" from a GitHub URL. Accepts HTTPS and SSH, with or without `.git`. */
export function parseNwo(githubUrl: string): string | null {
  const match = githubUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/** Extract the PR number from a full URL like `https://github.com/org/repo/pull/42`. */
export function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a user-supplied PR identifier. Accepts a full URL, `#42`, or `42`. */
export function parsePrIdentifier(identifier: string): number | null {
  const fromUrl = parsePrNumberFromUrl(identifier);
  if (fromUrl !== null) return fromUrl;
  const numMatch = identifier.match(/#?(\d+)/);
  if (!numMatch) return null;
  const parsed = Number(numMatch[1]);
  return Number.isFinite(parsed) ? parsed : null;
}
