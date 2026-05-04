/**
 * Generic file-output validation for agent output contracts.
 * Text means non-empty; JSON additionally must parse and satisfy a strict schema.
 */

import { readFile, stat } from "node:fs/promises";
import type { ResolvedFileOutputContract } from "./contracts.js";

export type OutputValidation<T = unknown> =
  | { valid: true; data?: T }
  | { valid: false; reason: string; soft: boolean };

/** Validate one resolved output contract against the filesystem. */
export async function validateFileOutput<T>(contract: ResolvedFileOutputContract<T>): Promise<OutputValidation<T>> {
  const exists = await stat(contract.path)
    .then((info) => info.isFile() && info.size > 0)
    .catch(() => false);
  if (!exists) return missing<T>(contract);

  const raw = await readFile(contract.path, "utf8").catch((err) => {
    throw new Error(`Failed to read ${contract.id} at ${contract.path}: ${String(err)}`);
  });

  if (raw.trim().length === 0) {
    return invalid<T>(contract, `${contract.id} is empty at ${contract.path}`);
  }

  if (contract.kind === "text") return { valid: true, data: raw as T };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return invalid<T>(contract, `${contract.id} is malformed JSON at ${contract.path}: ${String(err)}`);
  }

  const schemaResult = contract.schema?.safeParse(parsed);
  if (!schemaResult?.success) {
    return invalid<T>(
      contract,
      `${contract.id} failed schema validation at ${contract.path}: ${schemaResult?.error.message ?? "missing schema"}`,
    );
  }

  return { valid: true, data: schemaResult.data };
}

/** Validate outputs in order, short-circuiting on the first hard failure. */
export async function validateFileOutputs(
  contracts: readonly ResolvedFileOutputContract[],
): Promise<OutputValidation<readonly unknown[]>> {
  const data: unknown[] = [];
  for (const contract of contracts) {
    const result = await validateFileOutput(contract);
    if (!result.valid) {
      if (result.soft) continue;
      return result;
    }
    data.push(result.data);
  }
  return { valid: true, data };
}

function missing<T>(contract: ResolvedFileOutputContract<T>): OutputValidation<T> {
  if (contract.policy === "optional") return { valid: true };
  return invalid<T>(contract, `${contract.id} missing at ${contract.path}`);
}

function invalid<T>(contract: ResolvedFileOutputContract<T>, reason: string): OutputValidation<T> {
  return { valid: false, reason, soft: contract.policy === "softRequired" };
}
