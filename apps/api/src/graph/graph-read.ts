import type { Pool } from "pg";
import { pullRequestStateSchema, workflowRunStateSchema } from "./artifact-state.js";
import { workItemStates, type Basis, type WorkItemState } from "./state.js";

/** Agents are source keys such as "codex"; people are GitHub logins of pull request authors. */
export type Contributors = { agents: string[]; people: string[] };

export type GraphView = {
  revision: number;
  features: Array<{
    id: string;
    title: string;
    summary: string;
    counts: Partial<Record<WorkItemState, number>>;
    contributors: Contributors;
    lastActivityAt: string | null;
    workItems: Array<{
      id: string;
      title: string;
      state: WorkItemState;
      stateBasis: Basis;
      blocked: boolean;
      pullRequests: number[];
      lastActivityAt: string | null;
    }>;
  }>;
  relationships: Array<{ id: string; kind: "depends_on"; from: string; to: string; basis: Basis }>;
  pendingAnalysis: number;
  pendingSince: string | null;
};

export async function readRevision(pool: Pool, projectId: string): Promise<number | null> {
  const result = await pool.query<{ graph_revision: string }>(`select graph_revision from projects where id = $1`, [projectId]);
  const row = result.rows[0];
  return row ? Number(row.graph_revision) : null;
}

export async function readGraph(pool: Pool, projectId: string): Promise<GraphView | null> {
  const revision = await readRevision(pool, projectId);
  if (revision === null) {
    return null;
  }
  const features = await pool.query<{ id: string; title: string; summary: string }>(
    `select id, title, summary from feature_groups
     where project_id = $1 and retired_into is null
     order by created_at, id`,
    [projectId],
  );
  const items = await pool.query<{
    id: string;
    feature_id: string;
    title: string;
    state: WorkItemState;
    state_basis: Basis;
    blocked: boolean;
    pulls: number[];
    agents: string[];
    people: string[];
    last_activity: Date | null;
  }>(
    `select wi.id, wi.feature_id, wi.title, wi.state, wi.state_basis, wi.blocked,
            coalesce(pr.pulls, '{}') as pulls,
            coalesce(pr.people, '{}') as people,
            coalesce(ev.agents, '{}') as agents,
            greatest(pr.last_at, ev.last_at) as last_activity
     from work_items wi
     left join lateral (
       select array_agg(a.number order by a.number) as pulls,
              array_agg(distinct a.state->>'author') filter (where a.state->>'author' is not null) as people,
              max(a.source_updated_at) as last_at
       from work_item_artifacts wa
       join artifacts a on a.id = wa.artifact_id
       where wa.work_item_id = wi.id and a.kind = 'pull_request'
     ) pr on true
     left join lateral (
       select array_agg(distinct e.source) filter (where e.kind = 'session_excerpt') as agents,
              max(e.observed_at) as last_at
       from work_item_evidence we
       join evidence e on e.id = we.evidence_id
       where we.work_item_id = wi.id
     ) ev on true
     where wi.project_id = $1 and wi.retired_into is null
     order by wi.created_at, wi.id`,
    [projectId],
  );
  const relationships = await pool.query<{ id: string; from_work_item_id: string; to_work_item_id: string; basis: Basis }>(
    `select r.id, r.from_work_item_id, r.to_work_item_id, r.basis from relationships r
     join work_items a on a.id = r.from_work_item_id and a.retired_into is null
     join work_items b on b.id = r.to_work_item_id and b.retired_into is null
     where r.project_id = $1 and r.dismissed_at is null
     order by r.created_at, r.id`,
    [projectId],
  );
  const pending = await pool.query<{ count: string; since: Date | null }>(
    `select count(*), min(created_at) as since from evidence
     where project_id = $1 and (interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at is not null))`,
    [projectId],
  );
  return {
    revision,
    features: features.rows.map((feature) => {
      const rows = items.rows.filter((item) => item.feature_id === feature.id);
      const workItems = rows.map((item) => ({
        id: item.id,
        title: item.title,
        state: item.state,
        stateBasis: item.state_basis,
        blocked: item.blocked,
        pullRequests: item.pulls,
        lastActivityAt: item.last_activity?.toISOString() ?? null,
      }));
      const counts: Partial<Record<WorkItemState, number>> = {};
      for (const state of workItemStates) {
        const count = workItems.filter((item) => item.state === state).length;
        if (count > 0) {
          counts[state] = count;
        }
      }
      const activity = workItems.map((item) => item.lastActivityAt).filter((value): value is string => value !== null);
      return {
        id: feature.id,
        title: feature.title,
        summary: feature.summary,
        counts,
        contributors: {
          agents: sortedUnique(rows.flatMap((item) => item.agents)),
          people: sortedUnique(rows.flatMap((item) => item.people)),
        },
        lastActivityAt: activity.length > 0 ? activity.reduce((max, value) => (value > max ? value : max)) : null,
        workItems,
      };
    }),
    relationships: relationships.rows.map((row) => ({
      id: row.id,
      kind: "depends_on" as const,
      from: row.from_work_item_id,
      to: row.to_work_item_id,
      basis: row.basis,
    })),
    pendingAnalysis: Number(pending.rows[0]?.count ?? 0),
    pendingSince: pending.rows[0]?.since?.toISOString() ?? null,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function resolve(pool: Pool, kind: "feature" | "work_item", id: string): Promise<string> {
  const result = await pool.query<{ surviving_id: string }>(
    `select surviving_id from identity_aliases where entity_kind = $1 and retired_id = $2`,
    [kind, id],
  );
  return result.rows[0]?.surviving_id ?? id;
}

async function history(pool: Pool, projectId: string, kind: "feature" | "work_item", id: string) {
  const result = await pool.query<{
    revision: string;
    change: string;
    before: unknown;
    after: unknown;
    basis: Basis;
    evidence_ids: string[];
    created_at: Date;
    actor: string | null;
  }>(
    `select g.revision, g.change, g.before, g.after, g.basis, g.evidence_ids, g.created_at, p.github_login as actor
     from graph_changes g
     left join corrections c on c.id = g.correction_id
     left join profiles p on p.user_id = c.user_id
     where g.project_id = $1 and g.entity_kind = $2 and g.entity_id = $3
     order by g.id desc
     limit 100`,
    [projectId, kind, id],
  );
  return result.rows.map((row) => ({
    revision: Number(row.revision),
    change: row.change,
    before: row.before,
    after: row.after,
    basis: row.basis,
    evidenceIds: row.evidence_ids,
    actor: row.actor,
    at: row.created_at.toISOString(),
  }));
}

export async function readWorkItem(pool: Pool, projectId: string, requestedId: string) {
  const id = await resolve(pool, "work_item", requestedId);
  const itemResult = await pool.query<{
    id: string;
    feature_id: string;
    feature_title: string;
    title: string;
    title_basis: Basis;
    summary: string;
    summary_basis: Basis;
    state: WorkItemState;
    state_basis: Basis;
    blocked: boolean;
    blocked_reason: string | null;
    updated_at: Date;
  }>(
    `select wi.id, wi.feature_id, f.title as feature_title, wi.title, wi.title_basis, wi.summary, wi.summary_basis,
            wi.state, wi.state_basis, wi.blocked, wi.blocked_reason, wi.updated_at
     from work_items wi
     join feature_groups f on f.id = wi.feature_id
     where wi.id = $1 and wi.project_id = $2 and wi.retired_into is null`,
    [id, projectId],
  );
  const item = itemResult.rows[0];
  if (!item) {
    return null;
  }
  const pulls = await pool.query<{ id: string; url: string; state: unknown; basis: Basis; head_sha: string | null }>(
    `select a.id, a.url, a.state, wa.basis, a.head_sha from work_item_artifacts wa
     join artifacts a on a.id = wa.artifact_id
     where wa.work_item_id = $1 and a.kind = 'pull_request'
     order by a.number`,
    [id],
  );
  const pullStates = pulls.rows.map((row) => ({ row, state: pullRequestStateSchema.parse(row.state) }));
  const runs = await pool.query<{ id: string; url: string; state: unknown; head_sha: string | null }>(
    `select id, url, state, head_sha from artifacts
     where project_id = $1 and kind = 'workflow_run'
       and (
         exists (select 1 from jsonb_array_elements_text(state->'pullRequestNumbers') n where n::int = any($2::int[]))
         or (jsonb_array_length(state->'pullRequestNumbers') = 0 and head_sha = any($3::text[]))
       )
     order by source_updated_at desc`,
    [projectId, pullStates.map((pull) => pull.state.number), pullStates.map((pull) => pull.state.headSha)],
  );
  const runStates = runs.rows.map((row) => ({ row, state: workflowRunStateSchema.parse(row.state) }));
  const evidence = await pool.query<{
    id: string;
    kind: "session_excerpt" | "pull_request";
    source: string;
    session_id: string | null;
    excerpt: string;
    observed_at: Date;
    basis: Basis;
  }>(
    `select e.id, e.kind, e.source, e.session_id, e.excerpt, e.observed_at, we.basis
     from work_item_evidence we
     join evidence e on e.id = we.evidence_id
     where we.work_item_id = $1
     order by e.observed_at desc, e.id`,
    [id],
  );
  const relationships = await pool.query<{ id: string; from_work_item_id: string; to_work_item_id: string; basis: Basis; evidence_ids: string[]; other_title: string }>(
    `select r.id, r.from_work_item_id, r.to_work_item_id, r.basis, r.evidence_ids,
            (select title from work_items where id = case when r.from_work_item_id = $1 then r.to_work_item_id else r.from_work_item_id end) as other_title
     from relationships r
     where (r.from_work_item_id = $1 or r.to_work_item_id = $1) and r.dismissed_at is null`,
    [id],
  );

  const contributors: Contributors = {
    agents: sortedUnique(evidence.rows.filter((row) => row.kind === "session_excerpt").map((row) => row.source)),
    people: sortedUnique(pullStates.flatMap((pull) => (pull.state.author ? [pull.state.author] : []))),
  };

  return {
    id: item.id,
    ...(item.id !== requestedId ? { mergedFrom: requestedId } : {}),
    feature: { id: item.feature_id, title: item.feature_title },
    title: { value: item.title, basis: item.title_basis },
    summary: { value: item.summary, basis: item.summary_basis },
    state: { value: item.state, basis: item.state_basis },
    blocked: item.blocked ? { reason: item.blocked_reason } : null,
    contributors,
    pullRequests: pullStates.map(({ row, state }) => ({
      artifactId: row.id,
      number: state.number,
      title: state.title,
      url: row.url,
      state: state.state,
      draft: state.draft,
      merged: state.merged,
      author: state.author,
      reviews: state.reviews,
      basis: row.basis,
      runs: runStates
        .filter((run) => run.state.pullRequestNumbers.includes(state.number) || (run.state.pullRequestNumbers.length === 0 && run.row.head_sha === row.head_sha))
        .map((run) => ({
          artifactId: run.row.id,
          runId: run.state.runId,
          url: run.row.url,
          status: run.state.status,
          conclusion: run.state.conclusion,
          attempt: run.state.attempt,
          attempts: run.state.attempts,
          jobs: run.state.jobs,
        })),
    })),
    evidence: evidence.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      source: row.source,
      sessionId: row.session_id,
      excerpt: row.excerpt,
      observedAt: row.observed_at.toISOString(),
      basis: row.basis,
    })),
    relationships: relationships.rows.map((row) => ({
      id: row.id,
      direction: row.from_work_item_id === id ? ("depends_on" as const) : ("needed_by" as const),
      workItemId: row.from_work_item_id === id ? row.to_work_item_id : row.from_work_item_id,
      title: row.other_title,
      basis: row.basis,
      evidenceIds: row.evidence_ids,
    })),
    history: await history(pool, projectId, "work_item", id),
    updatedAt: item.updated_at.toISOString(),
  };
}

export async function readFeature(pool: Pool, projectId: string, requestedId: string) {
  const id = await resolve(pool, "feature", requestedId);
  const feature = await pool.query<{ id: string; title: string; title_basis: Basis; summary: string; summary_basis: Basis }>(
    `select id, title, title_basis, summary, summary_basis from feature_groups
     where id = $1 and project_id = $2 and retired_into is null`,
    [id, projectId],
  );
  const row = feature.rows[0];
  if (!row) {
    return null;
  }
  const items = await pool.query<{ id: string; title: string; summary: string; state: WorkItemState; state_basis: Basis; blocked: boolean }>(
    `select id, title, summary, state, state_basis, blocked from work_items
     where feature_id = $1 and retired_into is null
     order by created_at, id`,
    [id],
  );
  const people = await pool.query<{ name: string }>(
    `select distinct a.state->>'author' as name
     from work_items wi
     join work_item_artifacts wa on wa.work_item_id = wi.id
     join artifacts a on a.id = wa.artifact_id
     where wi.feature_id = $1 and wi.retired_into is null and a.state->>'author' is not null`,
    [id],
  );
  const agents = await pool.query<{ name: string }>(
    `select distinct e.source as name
     from work_items wi
     join work_item_evidence we on we.work_item_id = wi.id
     join evidence e on e.id = we.evidence_id
     where wi.feature_id = $1 and wi.retired_into is null and e.kind = 'session_excerpt'`,
    [id],
  );
  return {
    id: row.id,
    ...(row.id !== requestedId ? { mergedFrom: requestedId } : {}),
    title: { value: row.title, basis: row.title_basis },
    summary: { value: row.summary, basis: row.summary_basis },
    workItems: items.rows.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      state: item.state,
      stateBasis: item.state_basis,
      blocked: item.blocked,
    })),
    contributors: {
      agents: sortedUnique(agents.rows.map((row) => row.name)),
      people: sortedUnique(people.rows.map((row) => row.name)),
    },
    history: await history(pool, projectId, "feature", id),
  };
}
