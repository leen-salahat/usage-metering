import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string, max = 10) {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
