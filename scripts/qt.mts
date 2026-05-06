import 'dotenv/config';
import { getDb } from '../src/db/index.js';
import { tasks } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

const db = getDb();
const rows = await db.select().from(tasks).where(sql`${tasks.id}::text LIKE 'e458225f%'`);
console.log(JSON.stringify(rows, null, 2));
