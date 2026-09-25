import type { PoolClient } from "pg";
import { normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import {
  pullRequestStateSchema,
  visiblePullRequest,
  visibleWorkflowRun,
  workflowRunStateSchema,
  type PullRequestState,
  type WorkflowRunState,
} from "./artifact-state.js";
import { pullRequestExcerpt, recordKey, sessionExcerpts, textFingerprint } from "./evidence.js";
import { ChangeSet, commitChanges, recomputeWorkItemStates, type LockedProject } from "./graph-store.js";

export const factsBatchLimit = 200;

export type FactsResult = {
  batchId: string;
  applied: number;
  invalid: number;
  evidenceCreated: number;
  revision: number | null;
};

type EventRow = {
  event_id: string;
  source_key: string;
  project_id: string;
  source: string;
  occurred_at: Date;
  details: unknown;
  schema_version: number;
};

type Details<K extends NormalizedEvent["details"]["kind"]> = Extract<NormalizedEvent["details"], { kind: K }>;

type FactsContext = {
  client: PoolClient;
  projectId: string;
  changes: ChangeSet;
  affected: Set<string>;
  evidenceCreated: number;
};

const kindOrder: Record<NormalizedEvent["details"]["kind"], number> = {
  "session.started": 0,
  "session.content_added": 1,
  "pr.updated": 2,
  "workflow.updated": 3,
  "pr.reviewed": 4,
};

/**
 * Applies stored events to artifacts, sessions and evidence without calling AI. Runs inside the caller's
 * transaction so the events' completion marker commits with the facts.
 */
export async function applyFactsBatch(client: PoolClient, project: LockedProject): Promise<FactsResult | null> {
  const pending = await client.query<EventRow>(
    `select event_id, source_key, project_id, source, occurred_at, details, schema_version
     from normalized_events
     where project_id = $1 and facts_state = 'pending'
     order by occurred_at, event_id
     limit $2`,
    [project.id, factsBatchLimit],
  );
  if (pending.rows.length === 0) {
    return null;
  }
  const batch = await client.query<{ id: string }>(
    `insert into processing_batches (project_id, stage, status, event_ids, base_revision)
     values ($1, 'facts', 'running', $2, $3) returning id`,
    [project.id, pending.rows.map((row) => row.event_id), project.revision],
  );
  const batchId = batch.rows[0]?.id;
  if (!batchId) {
    throw new Error("Facts batch insert did not return an id.");
  }

  const context: FactsContext = {
    client,
    projectId: project.id,
    changes: new ChangeSet(),
    affected: new Set(),
    evidenceCreated: 0,
  };
  const parsed = pending.rows
    .map((row) => ({ row, event: parseEvent(row) }))
    .sort((a, b) => order(a.event) - order(b.event));
  const applied: string[] = [];
  const invalid: Array<{ eventId: string; reason: string }> = [];

  for (const { row, event } of parsed) {
    if (!event) {
      invalid.push({ eventId: row.event_id, reason: "invalid_event" });
      continue;
    }
    await client.query("savepoint fact_event");
    try {
      await applyEvent(context, event);
      await client.query("release savepoint fact_event");
      applied.push(event.eventId);
    } catch (error) {
      await client.query("rollback to savepoint fact_event");
      invalid.push({ eventId: event.eventId, reason: error instanceof Error ? error.message : "facts_failed" });
    }
  }

  await recomputeWorkItemStates(client, context.affected, context.changes);
  const revision = await commitChanges(client, project.id, context.changes, { batchId });
  await client.query(
    `update normalized_events set facts_state = 'applied', facts_batch_id = $2 where event_id = any($1::text[])`,
    [applied, batchId],
  );
  await client.query(
    `update normalized_events set facts_state = 'invalid', facts_batch_id = $2 where event_id = any($1::text[])`,
    [invalid.map((item) => item.eventId), batchId],
  );
  await client.query(
    `update processing_batches
     set status = $2, result_revision = $3, rejected = $4::jsonb, completed_at = now()
     where id = $1`,
    [batchId, revision === null ? "no_change" : "applied", revision, invalid.length > 0 ? JSON.stringify(invalid) : null],
  );
  return { batchId, applied: applied.length, invalid: invalid.length, evidenceCreated: context.evidenceCreated, revision };
}

function parseEvent(row: EventRow): NormalizedEvent | null {
  const result = normalizedEventSchema.safeParse({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    sourceKey: row.source_key,
    projectId: row.project_id,
    source: row.source,
    occurredAt: row.occurred_at.toISOString(),
    details: row.details,
  });
  return result.success ? result.data : null;
}

function order(event: NormalizedEvent | null): number {
  return event ? kindOrder[event.details.kind] : -1;
}

async function applyEvent(context: FactsContext, event: NormalizedEvent): Promise<void> {
  const details = event.details;
  switch (details.kind) {
    case "session.started":
      await upsertSession(context, event, details.sessionId, details.createdAt, details.sourceVersion);
      return;
    case "session.content_added":
      await upsertSession(context, event, details.sessionId, details.createdAt, details.sourceVersion);
      await addSessionEvidence(context, event, details);
      return;
    case "pr.updated":
      await applyPullRequest(context, event, details);
      return;
    case "pr.reviewed":
      await applyReview(context, details);
      return;
    case "workflow.updated":
      await applyWorkflow(context, event, details);
      return;
    default: {
      const unhandled: never = details;
      throw new Error(`Unhandled event kind ${JSON.stringify(unhandled)}`);
    }
  }
}

async function upsertSession(
  context: FactsContext,
  event: NormalizedEvent,
  sessionId: string,
  createdAt: string,
  sourceVersion: string | null,
): Promise<void> {
  await context.client.query(
    `insert into sessions (project_id, source, session_id, created_at, source_version, first_event_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, source, session_id) do nothing`,
    [context.projectId, event.source, sessionId, createdAt, sourceVersion, event.eventId],
  );
}

async function addSessionEvidence(
  context: FactsContext,
  event: NormalizedEvent,
  details: Details<"session.content_added">,
): Promise<void> {
  const known = await context.client.query<{ key: string }>(
    `select distinct unnest(record_keys) as key
     from evidence
     where project_id = $1 and source = $2 and session_id = $3`,
    [context.projectId, event.source, details.sessionId],
  );
  const seen = new Set(known.rows.map((row) => row.key));
  const fresh = details.messages.filter((message) => {
    const key = recordKey(message);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  for (const [part, excerpt] of sessionExcerpts(fresh).entries()) {
    const inserted = await context.client.query(
      `insert into evidence
         (project_id, event_id, part, kind, source, session_id, record_ids, record_keys, excerpt, observed_at)
       values ($1, $2, $3, 'session_excerpt', $4, $5, $6, $7, $8, $9)
       on conflict (event_id, part) do nothing`,
      [
        context.projectId,
        event.eventId,
        part,
        event.source,
        details.sessionId,
        excerpt.records.map((record) => record.id),
        excerpt.records.map(recordKey),
        excerpt.excerpt,
        excerpt.observedAt,
      ],
    );
    context.evidenceCreated += inserted.rowCount ?? 0;
  }
}

type ArtifactRow = { id: string; state: unknown; text_fingerprint: string | null };

async function findArtifact(
  context: FactsContext,
  kind: "pull_request" | "workflow_run",
  sourceId: string,
): Promise<ArtifactRow | null> {
  const result = await context.client.query<ArtifactRow>(
    `select id, state, text_fingerprint from artifacts
     where project_id = $1 and kind = $2 and source_id = $3
     for update`,
    [context.projectId, kind, sourceId],
  );
  return result.rows[0] ?? null;
}

async function applyPullRequest(context: FactsContext, event: NormalizedEvent, details: Details<"pr.updated">): Promise<void> {
  const sourceId = String(details.pullRequestId);
  const existing = await findArtifact(context, "pull_request", sourceId);
  const previous = existing ? pullRequestStateSchema.parse(existing.state) : null;
  const incomingAt = Date.parse(details.updatedAt);
  const previousAt = previous ? Date.parse(previous.updatedAt) : Number.NEGATIVE_INFINITY;
  if (previous && incomingAt < previousAt && !(details.merged && !previous.merged)) {
    return;
  }
  const merged = details.merged || (previous?.merged === true && incomingAt <= previousAt);
  const state = merged ? "closed" : details.state;
  const updatedAt = new Date(Math.max(incomingAt, previousAt)).toISOString();
  const next: PullRequestState = {
    number: details.number,
    title: details.title,
    state,
    draft: details.draft,
    merged,
    author: details.author ?? previous?.author ?? null,
    headSha: details.headSha,
    mergedAt: merged ? (previous?.mergedAt ?? details.updatedAt) : null,
    closedAt: state === "closed" ? (previous?.state === "closed" && previous.closedAt ? previous.closedAt : details.updatedAt) : null,
    commits: details.commits ?? previous?.commits ?? [],
    reviews: previous?.reviews ?? [],
    updatedAt,
  };
  const fingerprint = textFingerprint(details.title, details.body);
  const saved = await context.client.query<{ id: string }>(
    `insert into artifacts (project_id, kind, source_id, number, head_sha, url, state, source_updated_at, text_fingerprint)
     values ($1, 'pull_request', $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (project_id, kind, source_id) do update
       set number = excluded.number,
           head_sha = excluded.head_sha,
           url = excluded.url,
           state = excluded.state,
           source_updated_at = excluded.source_updated_at,
           text_fingerprint = excluded.text_fingerprint
     returning id`,
    [context.projectId, sourceId, details.number, details.headSha, details.url, JSON.stringify(next), updatedAt, fingerprint],
  );
  const artifactId = saved.rows[0]?.id;
  if (!artifactId) {
    throw new Error("Pull request artifact upsert did not return an id.");
  }

  let newEvidenceId: string | null = null;
  if (existing?.text_fingerprint !== fingerprint) {
    const inserted = await context.client.query<{ id: string }>(
      `insert into evidence (project_id, event_id, part, kind, source, artifact_id, excerpt, observed_at)
       values ($1, $2, 0, 'pull_request', 'github', $3, $4, $5)
       on conflict (event_id, part) do nothing
       returning id`,
      [
        context.projectId,
        event.eventId,
        artifactId,
        pullRequestExcerpt({
          number: details.number,
          title: details.title,
          body: details.body,
          commits: details.commits ?? [],
          files: details.files ?? [],
        }),
        details.updatedAt,
      ],
    );
    newEvidenceId = inserted.rows[0]?.id ?? null;
    context.evidenceCreated += inserted.rowCount ?? 0;
  }

  const linked = await linkedWorkItems(context, [artifactId]);
  for (const workItemId of linked) {
    context.affected.add(workItemId);
    if (newEvidenceId) {
      await attachPullRequestEvidence(context, workItemId, artifactId, newEvidenceId);
    }
  }
  if (previous) {
    recordVisibleChange(context, linked, "pull_request_updated", artifactId, visibleWithNumber(previous), visibleWithNumber(next));
  }
}

/** A pull request already on a work item brings its new description along without waiting for AI. */
async function attachPullRequestEvidence(context: FactsContext, workItemId: string, artifactId: string, evidenceId: string): Promise<void> {
  const inserted = await context.client.query(
    `insert into work_item_evidence (work_item_id, evidence_id, basis)
     select $1, $2, 'observed'
     where not exists (
       select 1 from link_blocks where work_item_id = $1 and target_kind = 'evidence' and target_id = $2
     )
     on conflict do nothing`,
    [workItemId, evidenceId],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    return;
  }
  await context.client.query(
    `update work_item_artifacts set evidence_ids = array_append(evidence_ids, $3::uuid)
     where work_item_id = $1 and artifact_id = $2`,
    [workItemId, artifactId, evidenceId],
  );
  context.changes.add({
    entityKind: "work_item",
    entityId: workItemId,
    change: "evidence_attached",
    before: null,
    after: { evidenceIds: [evidenceId] },
    basis: "observed",
    evidenceIds: [evidenceId],
  });
}

function visibleWithNumber(state: PullRequestState) {
  return { number: state.number, ...visiblePullRequest(state) };
}

async function applyReview(context: FactsContext, details: Details<"pr.reviewed">): Promise<void> {
  const existing = await findArtifact(context, "pull_request", String(details.pullRequestId));
  if (!existing) {
    return;
  }
  const previous = pullRequestStateSchema.parse(existing.state);
  if (previous.reviews.some((review) => review.reviewId === details.reviewId)) {
    return;
  }
  const next: PullRequestState = {
    ...previous,
    reviews: [
      ...previous.reviews,
      { reviewId: details.reviewId, reviewer: details.reviewer, decision: details.decision, submittedAt: details.submittedAt },
    ],
  };
  await context.client.query(`update artifacts set state = $2::jsonb where id = $1`, [existing.id, JSON.stringify(next)]);
  const linked = await linkedWorkItems(context, [existing.id]);
  recordVisibleChange(context, linked, "pull_request_reviewed", existing.id, visibleWithNumber(previous), visibleWithNumber(next));
}

async function applyWorkflow(context: FactsContext, event: NormalizedEvent, details: Details<"workflow.updated">): Promise<void> {
  const sourceId = `run:${details.runId}`;
  const existing = await findArtifact(context, "workflow_run", sourceId);
  const previous = existing ? workflowRunStateSchema.parse(existing.state) : null;
  const next = details.jobId === null ? mergeRun(previous, details, event.occurredAt) : mergeJob(previous, details, event.occurredAt);
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) {
    return;
  }
  const saved = await context.client.query<{ id: string }>(
    `insert into artifacts (project_id, kind, source_id, number, head_sha, url, state, source_updated_at)
     values ($1, 'workflow_run', $2, null, $3, $4, $5::jsonb, $6)
     on conflict (project_id, kind, source_id) do update
       set head_sha = excluded.head_sha,
           url = excluded.url,
           state = excluded.state,
           source_updated_at = greatest(artifacts.source_updated_at, excluded.source_updated_at)
     returning id`,
    [context.projectId, sourceId, next.headSha, details.url, JSON.stringify(next), next.updatedAt],
  );
  const artifactId = saved.rows[0]?.id;
  if (!artifactId) {
    throw new Error("Workflow run artifact upsert did not return an id.");
  }
  const pulls = await context.client.query<{ id: string }>(
    `select id from artifacts
     where project_id = $1 and kind = 'pull_request'
       and (number = any($2::int[]) or (cardinality($2::int[]) = 0 and head_sha = $3))`,
    [context.projectId, next.pullRequestNumbers, next.headSha],
  );
  const linked = await linkedWorkItems(
    context,
    pulls.rows.map((row) => row.id),
  );
  recordVisibleChange(context, linked, "ci_updated", artifactId, previous ? visibleWorkflowRun(previous) : null, visibleWorkflowRun(next));
}

function mergeRun(previous: WorkflowRunState | null, details: Details<"workflow.updated">, occurredAt: string): WorkflowRunState {
  const attempts = (previous?.attempts ?? []).filter((attempt) => attempt.attempt !== details.attempt);
  const earlierSame = previous?.attempts.find((attempt) => attempt.attempt === details.attempt);
  if (earlierSame && Date.parse(earlierSame.updatedAt) > Date.parse(occurredAt)) {
    attempts.push(earlierSame);
  } else {
    attempts.push({ attempt: details.attempt, status: details.status, conclusion: details.conclusion, updatedAt: occurredAt });
  }
  attempts.sort((a, b) => a.attempt - b.attempt);
  const jobs = details.jobs
    ? [
        ...(previous?.jobs ?? []).filter((job) => job.attempt !== details.attempt),
        ...details.jobs.map((job) => ({ ...job, updatedAt: occurredAt })),
      ]
    : (previous?.jobs ?? []);
  return summarizeRun(previous, details, attempts, jobs);
}

function mergeJob(previous: WorkflowRunState | null, details: Details<"workflow.updated">, occurredAt: string): WorkflowRunState {
  const jobs = [...(previous?.jobs ?? [])];
  const index = jobs.findIndex((job) => job.jobId === details.jobId && job.attempt === details.attempt);
  const current = index === -1 ? undefined : jobs[index];
  if (current && Date.parse(current.updatedAt) > Date.parse(occurredAt)) {
    return previous ?? summarizeRun(null, details, [], jobs);
  }
  const job = {
    jobId: details.jobId ?? 0,
    name: current?.name ?? "",
    status: details.status,
    conclusion: details.conclusion,
    attempt: details.attempt,
    updatedAt: occurredAt,
  };
  if (index === -1) {
    jobs.push(job);
  } else {
    jobs[index] = job;
  }
  const attempts = previous?.attempts ?? [];
  return summarizeRun(previous, details, attempts, jobs);
}

function summarizeRun(
  previous: WorkflowRunState | null,
  details: Details<"workflow.updated">,
  attempts: WorkflowRunState["attempts"],
  jobs: WorkflowRunState["jobs"],
): WorkflowRunState {
  const latest = attempts[attempts.length - 1];
  const pullRequestNumbers = [...new Set([...(previous?.pullRequestNumbers ?? []), ...details.pullRequestNumbers])].sort(
    (a, b) => a - b,
  );
  const updatedAt = [latest?.updatedAt, previous?.updatedAt, ...jobs.map((job) => job.updatedAt)]
    .filter((value): value is string => typeof value === "string")
    .reduce((max, value) => (Date.parse(value) > Date.parse(max) ? value : max), new Date(0).toISOString());
  return {
    runId: details.runId,
    status: latest?.status ?? previous?.status ?? "in_progress",
    conclusion: latest ? latest.conclusion : (previous?.conclusion ?? null),
    attempt: latest?.attempt ?? previous?.attempt ?? details.attempt,
    headSha: details.headSha,
    pullRequestNumbers,
    attempts,
    jobs: [...jobs].sort((a, b) => a.attempt - b.attempt || a.jobId - b.jobId),
    updatedAt,
  };
}

async function linkedWorkItems(context: FactsContext, artifactIds: readonly string[]): Promise<string[]> {
  if (artifactIds.length === 0) {
    return [];
  }
  const result = await context.client.query<{ work_item_id: string }>(
    `select distinct wa.work_item_id
     from work_item_artifacts wa
     join work_items wi on wi.id = wa.work_item_id
     where wa.artifact_id = any($1::uuid[]) and wi.retired_into is null`,
    [artifactIds],
  );
  return result.rows.map((row) => row.work_item_id);
}

function recordVisibleChange(
  context: FactsContext,
  workItemIds: readonly string[],
  change: string,
  artifactId: string,
  before: object | null,
  after: object,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return;
  }
  for (const workItemId of workItemIds) {
    context.changes.add({
      entityKind: "work_item",
      entityId: workItemId,
      change,
      before: before === null ? null : { artifactId, ...before },
      after: { artifactId, ...after },
      basis: "observed",
      evidenceIds: [],
    });
  }
}
