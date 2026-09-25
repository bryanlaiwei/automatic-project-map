import type { PoolClient } from "pg";
import { pullRequestStateSchema } from "./artifact-state.js";
import { computeWorkItemState, type Basis, type InferredState, type WorkItemState } from "./state.js";

export type LockedProject = {
  id: string;
  owner: string;
  name: string;
  revision: number;
};

/** Serializes interpretation, facts and corrections for one project. */
export async function lockProject(client: PoolClient, projectId: string): Promise<LockedProject | null> {
  const result = await client.query<{ id: string; github_owner: string; github_name: string; graph_revision: string }>(
    `select id, github_owner, github_name, graph_revision from projects where id = $1 for update`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: row.id, owner: row.github_owner, name: row.github_name, revision: Number(row.graph_revision) };
}

export type GraphChange = {
  entityKind: "feature" | "work_item" | "relationship";
  entityId: string;
  change: string;
  before: unknown;
  after: unknown;
  basis: Basis;
  evidenceIds: readonly string[];
};

export class ChangeSet {
  readonly items: GraphChange[] = [];

  add(change: GraphChange): void {
    this.items.push(change);
  }

  get empty(): boolean {
    return this.items.length === 0;
  }
}

/**
 * Writes the history rows and increases the revision once. Returns null and leaves the revision alone
 * when nothing a viewer can see changed.
 */
export async function commitChanges(
  client: PoolClient,
  projectId: string,
  changes: ChangeSet,
  origin: { batchId: string } | { correctionId: string },
): Promise<number | null> {
  if (changes.empty) {
    return null;
  }
  const bumped = await client.query<{ graph_revision: string }>(
    `update projects set graph_revision = graph_revision + 1 where id = $1 returning graph_revision`,
    [projectId],
  );
  const revision = Number(bumped.rows[0]?.graph_revision);
  const batchId = "batchId" in origin ? origin.batchId : null;
  const correctionId = "correctionId" in origin ? origin.correctionId : null;
  for (const change of changes.items) {
    await client.query(
      `insert into graph_changes
        (project_id, revision, entity_kind, entity_id, change, before, after, basis, evidence_ids, batch_id, correction_id)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::uuid[], $10, $11)`,
      [
        projectId,
        revision,
        change.entityKind,
        change.entityId,
        change.change,
        change.before === undefined ? null : JSON.stringify(change.before),
        change.after === undefined ? null : JSON.stringify(change.after),
        change.basis,
        change.evidenceIds,
        batchId,
        correctionId,
      ],
    );
  }
  return revision;
}

type StateRow = {
  id: string;
  state: WorkItemState;
  state_basis: Basis;
  inferred_state: InferredState | null;
  inferred_state_at: Date | null;
  pulls: unknown[];
  has_session: boolean;
};

/**
 * Recomputes the observed state from pull request facts. Items in `quiet` are updated without a history
 * row because their creation already records the state.
 */
export async function recomputeWorkItemStates(
  client: PoolClient,
  workItemIds: Iterable<string>,
  changes: ChangeSet,
  quiet: ReadonlySet<string> = new Set(),
): Promise<void> {
  const ids = [...new Set(workItemIds)];
  if (ids.length === 0) {
    return;
  }
  const rows = await client.query<StateRow>(
    `select wi.id, wi.state, wi.state_basis, wi.inferred_state, wi.inferred_state_at,
            coalesce((
              select json_agg(a.state)
              from work_item_artifacts wa
              join artifacts a on a.id = wa.artifact_id
              where wa.work_item_id = wi.id and a.kind = 'pull_request'
            ), '[]'::json) as pulls,
            exists (
              select 1
              from work_item_evidence we
              join evidence e on e.id = we.evidence_id
              where we.work_item_id = wi.id and e.kind = 'session_excerpt'
            ) as has_session
     from work_items wi
     where wi.id = any($1::uuid[]) and wi.retired_into is null`,
    [ids],
  );
  for (const row of rows.rows) {
    const pulls = row.pulls.map((value) => pullRequestStateSchema.parse(value));
    const next = computeWorkItemState({
      pullRequests: pulls.map((pull) => ({
        state: pull.state,
        draft: pull.draft,
        merged: pull.merged,
        closedAt: pull.closedAt,
      })),
      inferredState: row.inferred_state,
      inferredStateAt: row.inferred_state_at?.toISOString() ?? null,
      hasSessionEvidence: row.has_session,
    });
    if (next.state === row.state && next.basis === row.state_basis) {
      continue;
    }
    await client.query(`update work_items set state = $2, state_basis = $3, updated_at = now() where id = $1`, [
      row.id,
      next.state,
      next.basis,
    ]);
    if (!quiet.has(row.id) && next.state !== row.state) {
      changes.add({
        entityKind: "work_item",
        entityId: row.id,
        change: "state",
        before: { state: row.state, basis: row.state_basis },
        after: { state: next.state, basis: next.basis },
        basis: next.basis,
        evidenceIds: [],
      });
    }
  }
}

/** Follows merges so an id from before a merge reaches the surviving record. */
export async function resolveAlias(
  client: PoolClient,
  entityKind: "feature" | "work_item",
  id: string,
): Promise<string> {
  const result = await client.query<{ surviving_id: string }>(
    `select surviving_id from identity_aliases where entity_kind = $1 and retired_id = $2`,
    [entityKind, id],
  );
  return result.rows[0]?.surviving_id ?? id;
}
