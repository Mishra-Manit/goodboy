/**
 * Manual-test instance convention. Test drivers set `INSTANCE_ID=TEST-<hex>`
 * so their memory artifacts, memory_runs rows, and transcripts stay clearly
 * isolated from prod; the dashboard and cleanup logic key off this prefix
 * to render "TEST" badges and to target wipe operations.
 */

export const TEST_INSTANCE_PREFIX = "TEST-";

/** True when `instance` belongs to a manual-test run (not a deployed instance). */
export function isTestInstance(instance: string): boolean {
  return instance.startsWith(TEST_INSTANCE_PREFIX);
}
