import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

const pairingTtlMs = 10 * 60 * 1000;

export type CollectorDevice = {
  id: string;
  projectId: string;
  trackingStartedAt: string;
};

export function hashCollectorSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createPairingCode(
  pool: Pool,
  input: { projectId: string; userId: string; now?: Date },
): Promise<{ code: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + pairingTtlMs);
  await pool.query(
    `insert into collector_pairing_codes (code_hash, project_id, user_id, expires_at)
     values ($1, $2, $3, $4)`,
    [hashCollectorSecret(code), input.projectId, input.userId, expiresAt.toISOString()],
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function exchangePairingCode(
  pool: Pool,
  input: { code: string; label?: string; now?: Date },
): Promise<{ token: string; device: CollectorDevice } | { error: "invalid_code" }> {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query<{ project_id: string; tracking_started_at: Date }>(
      `select c.project_id, p.tracking_started_at
       from collector_pairing_codes c
       join projects p on p.id = c.project_id
       where c.code_hash = $1 and c.used_at is null and c.expires_at > $2
       for update`,
      [hashCollectorSecret(input.code), now.toISOString()],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query("rollback");
      return { error: "invalid_code" };
    }
    await client.query(`update collector_pairing_codes set used_at = $2 where code_hash = $1`, [
      hashCollectorSecret(input.code),
      now.toISOString(),
    ]);
    const token = `apm_${randomBytes(32).toString("base64url")}`;
    const inserted = await client.query<{ id: string }>(
      `insert into collector_tokens (project_id, label, token_hash)
       values ($1, $2, $3)
       returning id`,
      [row.project_id, input.label?.trim() || "local helper", hashCollectorSecret(token)],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      throw new Error("Collector token insert did not return an id");
    }
    await client.query("commit");
    return {
      token,
      device: {
        id,
        projectId: row.project_id,
        trackingStartedAt: row.tracking_started_at.toISOString(),
      },
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function findCollectorDevice(pool: Pool, token: string): Promise<CollectorDevice | null> {
  if (token.trim() === "") {
    return null;
  }
  const result = await pool.query<{ id: string; project_id: string; tracking_started_at: Date }>(
    `select t.id, t.project_id, p.tracking_started_at
     from collector_tokens t
     join projects p on p.id = t.project_id
     where t.token_hash = $1 and t.revoked_at is null`,
    [hashCollectorSecret(token)],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: row.id, projectId: row.project_id, trackingStartedAt: row.tracking_started_at.toISOString() };
}

export async function revokeCollectorToken(pool: Pool, token: string): Promise<boolean> {
  const result = await pool.query(
    `update collector_tokens
     set revoked_at = now()
     where token_hash = $1 and revoked_at is null`,
    [hashCollectorSecret(token)],
  );
  return (result.rowCount ?? 0) > 0;
}
