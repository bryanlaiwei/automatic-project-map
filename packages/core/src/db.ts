import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";

let pool: Pool | undefined;

export function getPool(): Pool {
  const connectionString = config().databaseUrl;
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

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
