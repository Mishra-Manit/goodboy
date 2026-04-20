/**
 * Lazy Drizzle client for Neon. `getDb()` is the single accessor; importing
 * this module has no side effects. `_db` stays module-private.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import { loadEnv } from "../shared/config.js";

type Db = NeonHttpDatabase<typeof schema>;

let _db: Db | null = null;

/** Get the shared Drizzle client. Connects on first call. */
export function getDb(): Db {
  if (!_db) {
    const sql = neon(loadEnv().DATABASE_URL);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export { schema };
