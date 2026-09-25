import type { Pool } from "pg";
import { normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import { normalizeGithubDelivery } from "./github.js";

export type ProjectRow = {
  id: string;
  workspace_id: string;
  github_repo_id: string;
  github_owner: string;
  github_name: string;
  tracking_started_at: Date;
};

type DeliveryRow = {
  delivery_id: string;
  event_name: string;
  payload: unknown;
  status: string;
};

export async function connectRepository(
  pool: Pool,
  input: { userId: string; owner: string; name: string; repoId: number },
): Promise<{ project: ProjectRow } | { error: "already_connected" | "repo_taken" }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<ProjectRow>(
      `select p.*
       from projects p
       join memberships m on m.workspace_id = p.workspace_id
       where m.user_id = $1`,
      [input.userId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query("rollback");
      return { error: "already_connected" };
    }

    const claimed = await client.query(`select 1 from projects where github_repo_id = $1`, [input.repoId]);
    if ((claimed.rowCount ?? 0) > 0) {
      await client.query("rollback");
      return { error: "repo_taken" };
    }

    const workspace = await client.query<{ id: string }>(
      `insert into workspaces (name) values ($1) returning id`,
      [`${input.owner}/${input.name}`],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) {
      throw new Error("Workspace insert did not return an id");
    }
    await client.query(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`,
      [workspaceId, input.userId],
    );
    const project = await client.query<ProjectRow>(
      `insert into projects (workspace_id, github_repo_id, github_owner, github_name, tracking_started_at)
       values ($1, $2, $3, $4, now())
       returning *`,
      [workspaceId, input.repoId, input.owner, input.name],
    );
    await client.query("commit");
    const created = project.rows[0];
    if (!created) {
      throw new Error("Project insert did not return a row");
    }
    return { project: created };
  } catch (error) {
    await client.query("rollback");
    if (isRepoIdConflict(error)) {
      return { error: "repo_taken" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjects(pool: Pool, userId: string): Promise<ProjectRow[]> {
  const result = await pool.query<ProjectRow>(
    `select p.*
     from projects p
     join memberships m on m.workspace_id = p.workspace_id
     where m.user_id = $1`,
    [userId],
  );
  return result.rows;
}

export async function findProjectByRepo(pool: Pool, repoId: number): Promise<ProjectRow | null> {
  const result = await pool.query<ProjectRow>(
    `select * from projects where github_repo_id = $1`,
    [repoId],
  );
  return result.rows[0] ?? null;
}

export async function getProjectForUser(pool: Pool, userId: string, projectId: string): Promise<ProjectRow | null> {
  const result = await pool.query<ProjectRow>(
    `select p.*
     from projects p
     join memberships m on m.workspace_id = p.workspace_id
     where p.id = $1 and m.user_id = $2`,
    [projectId, userId],
  );
  return result.rows[0] ?? null;
}

export async function userCanAccessProject(pool: Pool, userId: string, projectId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1
     from projects p
     join memberships m on m.workspace_id = p.workspace_id
     where p.id = $1 and m.user_id = $2`,
    [projectId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

type Queryable = {
  query: Pool["query"];
};

function isRepoIdConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  const constraint = "constraint" in error ? error.constraint : undefined;
  return code === "23505" && constraint === "projects_github_repo_id_key";
}

export async function insertEvents(pool: Pool, events: NormalizedEvent[]): Promise<number> {
  return insertEventsWith(pool, events);
}

export async function insertEventsWith(db: Queryable, events: NormalizedEvent[]): Promise<number> {
  let stored = 0;
  for (const event of events) {
    const parsed = normalizedEventSchema.parse(event);
    const result = await db.query(
      `insert into normalized_events
        (event_id, source_key, project_id, source, kind, occurred_at, details, schema_version)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       on conflict (event_id) do nothing`,
      [
        parsed.eventId,
        parsed.sourceKey,
        parsed.projectId,
        parsed.source,
        parsed.details.kind,
        parsed.occurredAt,
        JSON.stringify(parsed.details),
        parsed.schemaVersion,
      ],
    );
    stored += result.rowCount ?? 0;
  }
  return stored;
}

export async function listEvents(pool: Pool, projectId: string): Promise<NormalizedEvent[]> {
  const result = await pool.query<{
    event_id: string;
    source_key: string;
    project_id: string;
    source: NormalizedEvent["source"];
    occurred_at: Date;
    details: NormalizedEvent["details"];
    schema_version: number;
  }>(
    `select event_id, source_key, project_id, source, occurred_at, details, schema_version
     from normalized_events
     where project_id = $1
     order by occurred_at asc`,
    [projectId],
  );
  return result.rows.map((row) =>
    normalizedEventSchema.parse({
      schemaVersion: row.schema_version,
      eventId: row.event_id,
      sourceKey: row.source_key,
      projectId: row.project_id,
      source: row.source,
      occurredAt: row.occurred_at.toISOString(),
      details: row.details,
    }),
  );
}

export async function enqueueDelivery(
  pool: Pool,
  input: { deliveryId: string; eventName: string; repoId: number | null; payload: unknown },
): Promise<"queued" | "duplicate"> {
  const result = await pool.query(
    `insert into webhook_deliveries (delivery_id, event_name, github_repo_id, payload, status)
     values ($1, $2, $3, $4::jsonb, 'queued')
     on conflict (delivery_id) do nothing`,
    [input.deliveryId, input.eventName, input.repoId, JSON.stringify(input.payload)],
  );
  return (result.rowCount ?? 0) > 0 ? "queued" : "duplicate";
}

export async function processQueuedDeliveries(pool: Pool): Promise<number> {
  const queued = await pool.query<DeliveryRow>(
    `select delivery_id, event_name, payload, status
     from webhook_deliveries
     where status = 'queued'
     order by received_at asc`,
  );
  let processed = 0;
  for (const delivery of queued.rows) {
    await processDelivery(pool, delivery);
    processed += 1;
  }
  return processed;
}

export async function processDelivery(pool: Pool, delivery: DeliveryRow): Promise<void> {
  const payload = delivery.payload;
  const repoId =
    typeof payload === "object" &&
    payload !== null &&
    "repository" in payload &&
    typeof payload.repository === "object" &&
    payload.repository !== null &&
    "id" in payload.repository &&
    typeof payload.repository.id === "number"
      ? payload.repository.id
      : null;

  if (repoId === null) {
    await pool.query(
      `update webhook_deliveries
       set status = 'ignored', note = 'missing_repository', processed_at = now(), attempts = attempts + 1
       where delivery_id = $1`,
      [delivery.delivery_id],
    );
    return;
  }

  const project = await findProjectByRepo(pool, repoId);
  if (!project) {
    await pool.query(
      `update webhook_deliveries
       set status = 'ignored', note = 'repository_not_connected', processed_at = now(), attempts = attempts + 1
       where delivery_id = $1`,
      [delivery.delivery_id],
    );
    return;
  }

  const normalized = normalizeGithubDelivery({
    eventName: delivery.event_name,
    deliveryId: delivery.delivery_id,
    projectId: project.id,
    payload,
    receivedAt: new Date().toISOString(),
  });

  if (normalized.status === "ignore") {
    await pool.query(
      `update webhook_deliveries
       set status = 'ignored', note = $2, processed_at = now(), attempts = attempts + 1
       where delivery_id = $1`,
      [delivery.delivery_id, normalized.note],
    );
    return;
  }

  await insertEvents(pool, normalized.events);
  await pool.query(
    `update webhook_deliveries
     set status = 'processed', processed_at = now(), attempts = attempts + 1
     where delivery_id = $1`,
    [delivery.delivery_id],
  );
}
