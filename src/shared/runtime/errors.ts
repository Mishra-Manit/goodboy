/**
 * Tiny cross-cutting error helpers. Keep unknown-to-string conversion in one
 * place so logs, task failures, and API responses format errors consistently.
 */

// --- Public API ---

/** Convert an unknown thrown value into a user-safe message string. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
