import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT id, status, kind, error, created_at FROM tasks WHERE id::text LIKE '35318433%'`;
console.log(JSON.stringify(rows, null, 2));
