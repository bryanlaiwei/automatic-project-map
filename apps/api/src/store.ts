import type { Pool } from "pg";
import { normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import {
  applyPullRequestSnapshot,
  applyWorkflowSnapshot,
  preserveKnownMerge,
  pullRequestNumbersForHead,
  readKnownMerge,
  savePullRequestObservation,
  saveWorkflowObservation,
  type PullRequestSnapshot,
  type WorkflowSnapshot,
} from "./github-enrich.js";
import { normalizeGithubDelivery } from "./github.js";

export type GithubLookup = {
  enrichPullRequest(owner: string, name: string, number: number): Promise<PullRequestSnapshot | null>;
  enrichWorkflowRun(owner: string, name: string, runId: number): Promise<WorkflowSnapshot | null>;
};

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

export const deliveryAttemptLimit = 5;

export async function processQueuedDeliveries(
  pool: Pool,
  github?: GithubLookup,
  options: { olderThanSeconds?: number; deliveryIds?: string[] } = {},
): Promise<number> {
  const queued = await pool.query<DeliveryRow>(
    `select delivery_id, event_name, payload, status
     from webhook_deliveries
     where status = 'queued'
       and received_at <= now() - make_interval(secs => $1)
       and ($2::text[] is null or delivery_id = any($2::text[]))
     order by received_at asc
     limit 200`,
    [options.olderThanSeconds ?? 0, options.deliveryIds ?? null],
  );
  let processed = 0;
  for (const delivery of queued.rows) {
    try {
      await processDelivery(pool, delivery, github);
      processed += 1;
    } catch (error) {
      await recordDeliveryFailure(pool, delivery.delivery_id, error);
    }
  }
  return processed;
}

async function recordDeliveryFailure(pool: Pool, deliveryId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `update webhook_deliveries
     set attempts = attempts + 1,
         note = left($2, 500),
         status = case when attempts + 1 >= $3 then 'failed' else 'queued' end,
         processed_at = case when attempts + 1 >= $3 then now() else processed_at end
     where delivery_id = $1`,
    [deliveryId, message, deliveryAttemptLimit],
  );
}

export async function processDelivery(pool: Pool, delivery: DeliveryRow, github?: GithubLookup): Promise<void> {
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

  const events = await enrichDeliveryEvents(pool, project, normalized.events, github);
  await insertEvents(pool, events);
  for (const event of events) {
    await savePullRequestObservation(pool, project.id, event);
    await saveWorkflowObservation(pool, project.id, event);
  }
  await pool.query(
    `update webhook_deliveries
     set status = 'processed', processed_at = now(), attempts = attempts + 1
     where delivery_id = $1`,
    [delivery.delivery_id],
  );
}

async function enrichDeliveryEvents(
  pool: Pool,
  project: ProjectRow,
  events: NormalizedEvent[],
  github: GithubLookup | undefined,
): Promise<NormalizedEvent[]> {
  const enriched: NormalizedEvent[] = [];
  for (const event of events) {
    enriched.push(await enrichOneEvent(pool, project, event, github));
  }
  return enriched;
}

async function enrichOneEvent(
  pool: Pool,
  project: ProjectRow,
  event: NormalizedEvent,
  github: GithubLookup | undefined,
): Promise<NormalizedEvent> {
  if (event.details.kind === "pr.updated") {
    const fetched = github
      ? await github.enrichPullRequest(project.github_owner, project.github_name, event.details.number)
      : null;
    const known = await readKnownMerge(pool, project.id, event.details.pullRequestId);
    if (!fetched) {
      return applyPullRequestSnapshot(event, preserveKnownMerge(snapshotFromEvent(event), known));
    }
    return applyPullRequestSnapshot(event, preserveKnownMerge(fetched, known));
  }
  if (event.details.kind === "workflow.updated" && event.details.jobId === null) {
    const fetched = github
      ? await github.enrichWorkflowRun(project.github_owner, project.github_name, event.details.runId)
      : null;
    const snapshot = fetched ?? snapshotFromWorkflowEvent(event);
    if (snapshot.pullRequestNumbers.length === 0) {
      const matched = await pullRequestNumbersForHead(pool, project.id, snapshot.headSha);
      if (matched.length === 1) {
        snapshot.pullRequestNumbers = matched;
      }
    }
    return applyWorkflowSnapshot(event, snapshot);
  }
  return event;
}

function snapshotFromEvent(event: NormalizedEvent): PullRequestSnapshot {
  if (event.details.kind !== "pr.updated") {
    throw new Error("Expected a pull request event.");
  }
  return {
    title: event.details.title,
    body: event.details.body,
    url: event.details.url,
    draft: event.details.draft,
    state: event.details.state,
    merged: event.details.merged,
    headSha: event.details.headSha,
    updatedAt: event.details.updatedAt,
    commits: event.details.commits ?? [],
    files: event.details.files ?? [],
  };
}

function snapshotFromWorkflowEvent(event: NormalizedEvent): WorkflowSnapshot {
  if (event.details.kind !== "workflow.updated") {
    throw new Error("Expected a workflow event.");
  }
  return {
    status: event.details.status,
    conclusion: event.details.conclusion,
    headSha: event.details.headSha,
    attempt: event.details.attempt,
    url: event.details.url,
    updatedAt: event.occurredAt,
    pullRequestNumbers: [...event.details.pullRequestNumbers],
    jobs: event.details.jobs ?? [],
  };
}
