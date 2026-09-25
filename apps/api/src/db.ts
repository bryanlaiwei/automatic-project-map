import { Pool, type QueryResultRow } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  pool ??= new Pool({ connectionString });
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, values);
  return result.rows;
}
