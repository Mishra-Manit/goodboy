import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import { loadEnv } from "../shared/config.js";

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const env = loadEnv();
  const sql = neon(env.DATABASE_URL);
  return drizzle(sql, { schema });
}

export function getDb() {
  if (!_db) {
    _db = createDb();
  }
  return _db;
}

export { schema };
