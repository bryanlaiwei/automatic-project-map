import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ChangeSet, commitChanges, lockProject, recomputeWorkItemStates, resolveAlias } from "./graph-store.js";
import { inTransaction } from "./process.js";

const id = z.string().uuid();
const title = z.string().trim().min(1).max(120);

export const correctionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename"), target: z.enum(["feature", "work_item"]), id, title }),
  z.object({ kind: z.literal("move"), workItemId: id, featureId: id }),
  z.object({ kind: z.literal("merge"), target: z.enum(["feature", "work_item"]), retiredId: id, survivingId: id }),
  z.object({
    kind: z.literal("split"),
    workItemId: id,
    title,
    evidenceIds: z.array(id).default([]),
    artifactIds: z.array(id).default([]),
  }),
  z.object({ kind: z.literal("dismiss"), relationshipId: id }),
]);

export type Correction = z.infer<typeof correctionSchema>;

export type CorrectionResult =
  | { status: "applied"; correctionId: string; revision: number; createdWorkItemId: string | null }
  | { status: "not_found" | "invalid"; message: string };

class CorrectionError extends Error {
  constructor(
    readonly status: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

type Scope = {
  client: PoolClient;
  projectId: string;
  correctionId: string;
  changes: ChangeSet;
};

/** Applies a person's change and records it so later interpretation keeps it. */
export async function applyCorrection(
  pool: Pool,
  input: { projectId: string; userId: string; correction: Correction },
): Promise<CorrectionResult> {
  try {
    return await inTransaction(pool, async (client) => {
      const project = await lockProject(client, input.projectId);
      if (!project) {
        throw new CorrectionError("not_found", "Project not found.");
      }
      const inserted = await client.query<{ id: string }>(
        `insert into corrections (project_id, user_id, kind, payload, revision)
         values ($1, $2, $3, $4::jsonb, $5) returning id`,
        [input.projectId, input.userId, input.correction.kind, JSON.stringify(input.correction), project.revision],
      );
      const correctionId = inserted.rows[0]?.id;
      if (!correctionId) {
        throw new Error("Correction insert did not return an id.");
      }
      const scope: Scope = { client, projectId: input.projectId, correctionId, changes: new ChangeSet() };
      const createdWorkItemId = await apply(scope, input.correction);
      const revision = (await commitChanges(client, input.projectId, scope.changes, { correctionId })) ?? project.revision;
      await client.query(`update corrections set revision = $2 where id = $1`, [correctionId, revision]);
      return { status: "applied" as const, correctionId, revision, createdWorkItemId };
    });
  } catch (error) {
    if (error instanceof CorrectionError) {
      return { status: error.status, message: error.message };
    }
    throw error;
  }
}

async function apply(scope: Scope, correction: Correction): Promise<string | null> {
  switch (correction.kind) {
    case "rename":
      await rename(scope, correction.target, correction.id, correction.title);
      return null;
    case "move":
      await move(scope, correction.workItemId, correction.featureId);
      return null;
    case "merge":
      if (correction.target === "work_item") {
        await mergeWorkItems(scope, correction.retiredId, correction.survivingId);
      } else {
        await mergeFeatures(scope, correction.retiredId, correction.survivingId);
      }
      return null;
    case "split":
      return split(scope, correction);
    case "dismiss":
      await dismiss(scope, correction.relationshipId);
      return null;
    default: {
      const unhandled: never = correction;
      throw new CorrectionError("invalid", `Unknown correction ${JSON.stringify(unhandled)}.`);
    }
  }
}

async function activeWorkItem(scope: Scope, rawId: string): Promise<{ id: string; feature_id: string; title: string }> {
  const workItemId = await resolveAlias(scope.client, "work_item", rawId);
  const result = await scope.client.query<{ id: string; feature_id: string; title: string }>(
    `select id, feature_id, title from work_items
     where id = $1 and project_id = $2 and retired_into is null
     for update`,
    [workItemId, scope.projectId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CorrectionError("not_found", "Work item not found.");
  }
  return row;
}

async function activeFeature(scope: Scope, rawId: string): Promise<{ id: string; title: string }> {
  const featureId = await resolveAlias(scope.client, "feature", rawId);
  const result = await scope.client.query<{ id: string; title: string }>(
    `select id, title from feature_groups
     where id = $1 and project_id = $2 and retired_into is null
     for update`,
    [featureId, scope.projectId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CorrectionError("not_found", "Feature not found.");
  }
  return row;
}

async function rename(scope: Scope, target: "feature" | "work_item", rawId: string, value: string): Promise<void> {
  const current = target === "feature" ? await activeFeature(scope, rawId) : await activeWorkItem(scope, rawId);
  const table = target === "feature" ? "feature_groups" : "work_items";
  await scope.client.query(`update ${table} set title = $2, title_basis = 'human', updated_at = now() where id = $1`, [current.id, value]);
  if (current.title !== value) {
    scope.changes.add({
      entityKind: target,
      entityId: current.id,
      change: "title",
      before: { title: current.title },
      after: { title: value },
      basis: "human",
      evidenceIds: [],
    });
  }
}

async function move(scope: Scope, workItemId: string, featureId: string): Promise<void> {
  const item = await activeWorkItem(scope, workItemId);
  const feature = await activeFeature(scope, featureId);
  await scope.client.query(`update work_items set feature_id = $2, feature_basis = 'human', updated_at = now() where id = $1`, [
    item.id,
    feature.id,
  ]);
  if (item.feature_id !== feature.id) {
    scope.changes.add({
      entityKind: "work_item",
      entityId: item.id,
      change: "moved",
      before: { featureId: item.feature_id },
      after: { featureId: feature.id },
      basis: "human",
      evidenceIds: [],
    });
  }
}

async function mergeWorkItems(scope: Scope, retiredRaw: string, survivingRaw: string): Promise<void> {
  const retired = await activeWorkItem(scope, retiredRaw);
  const surviving = await activeWorkItem(scope, survivingRaw);
  if (retired.id === surviving.id) {
    throw new CorrectionError("invalid", "A work item cannot be merged into itself.");
  }
  const { client } = scope;
  await client.query(
    `insert into work_item_evidence (work_item_id, evidence_id, basis)
     select $2, we.evidence_id, we.basis from work_item_evidence we
     where we.work_item_id = $1
       and not exists (select 1 from link_blocks b where b.work_item_id = $2 and b.target_kind = 'evidence' and b.target_id = we.evidence_id)
     on conflict do nothing`,
    [retired.id, surviving.id],
  );
  await client.query(
    `insert into work_item_artifacts (work_item_id, artifact_id, basis, evidence_ids)
     select $2, wa.artifact_id, wa.basis, wa.evidence_ids from work_item_artifacts wa
     where wa.work_item_id = $1
       and not exists (select 1 from link_blocks b where b.work_item_id = $2 and b.target_kind = 'artifact' and b.target_id = wa.artifact_id)
     on conflict do nothing`,
    [retired.id, surviving.id],
  );
  await client.query(`delete from work_item_evidence where work_item_id = $1`, [retired.id]);
  await client.query(`delete from work_item_artifacts where work_item_id = $1`, [retired.id]);
  await client.query(
    `insert into link_blocks (work_item_id, target_kind, target_id, correction_id)
     select $2, target_kind, target_id, correction_id from link_blocks where work_item_id = $1
     on conflict do nothing`,
    [retired.id, surviving.id],
  );
  await repointRelationships(scope, retired.id, surviving.id);
  await client.query(`update work_items set retired_into = $2, updated_at = now() where id = $1`, [retired.id, surviving.id]);
  await recordAlias(scope, "work_item", retired.id, surviving.id);
  await recomputeWorkItemStates(client, [surviving.id], scope.changes);
  scope.changes.add({
    entityKind: "work_item",
    entityId: retired.id,
    change: "merged_into",
    before: { title: retired.title },
    after: { survivingId: surviving.id },
    basis: "human",
    evidenceIds: [],
  });
  scope.changes.add({
    entityKind: "work_item",
    entityId: surviving.id,
    change: "merged",
    before: null,
    after: { retiredId: retired.id, retiredTitle: retired.title },
    basis: "human",
    evidenceIds: [],
  });
}

async function repointRelationships(scope: Scope, retiredId: string, survivingId: string): Promise<void> {
  const rows = await scope.client.query<{ id: string; from_work_item_id: string; to_work_item_id: string }>(
    `select id, from_work_item_id, to_work_item_id from relationships
     where from_work_item_id = $1 or to_work_item_id = $1`,
    [retiredId],
  );
  for (const row of rows.rows) {
    const from = row.from_work_item_id === retiredId ? survivingId : row.from_work_item_id;
    const to = row.to_work_item_id === retiredId ? survivingId : row.to_work_item_id;
    const duplicate = await scope.client.query(
      `select 1 from relationships where from_work_item_id = $1 and to_work_item_id = $2 and kind = 'depends_on' and id <> $3`,
      [from, to, row.id],
    );
    if (from === to || (duplicate.rowCount ?? 0) > 0) {
      await scope.client.query(`delete from relationships where id = $1`, [row.id]);
      continue;
    }
    await scope.client.query(`update relationships set from_work_item_id = $2, to_work_item_id = $3 where id = $1`, [row.id, from, to]);
  }
}

async function mergeFeatures(scope: Scope, retiredRaw: string, survivingRaw: string): Promise<void> {
  const retired = await activeFeature(scope, retiredRaw);
  const surviving = await activeFeature(scope, survivingRaw);
  if (retired.id === surviving.id) {
    throw new CorrectionError("invalid", "A feature cannot be merged into itself.");
  }
  const moved = await scope.client.query<{ id: string }>(
    `update work_items set feature_id = $2, updated_at = now()
     where feature_id = $1 and retired_into is null
     returning id`,
    [retired.id, surviving.id],
  );
  await scope.client.query(`update feature_groups set retired_into = $2, updated_at = now() where id = $1`, [retired.id, surviving.id]);
  await recordAlias(scope, "feature", retired.id, surviving.id);
  for (const row of moved.rows) {
    scope.changes.add({
      entityKind: "work_item",
      entityId: row.id,
      change: "moved",
      before: { featureId: retired.id },
      after: { featureId: surviving.id },
      basis: "human",
      evidenceIds: [],
    });
  }
  scope.changes.add({
    entityKind: "feature",
    entityId: retired.id,
    change: "merged_into",
    before: { title: retired.title },
    after: { survivingId: surviving.id },
    basis: "human",
    evidenceIds: [],
  });
  scope.changes.add({
    entityKind: "feature",
    entityId: surviving.id,
    change: "merged",
    before: null,
    after: { retiredId: retired.id, retiredTitle: retired.title },
    basis: "human",
    evidenceIds: [],
  });
}

async function recordAlias(scope: Scope, kind: "feature" | "work_item", retiredId: string, survivingId: string): Promise<void> {
  await scope.client.query(
    `update identity_aliases set surviving_id = $3 where project_id = $1 and entity_kind = $2 and surviving_id = $4`,
    [scope.projectId, kind, survivingId, retiredId],
  );
  await scope.client.query(
    `insert into identity_aliases (project_id, entity_kind, retired_id, surviving_id, correction_id)
     values ($1, $2, $3, $4, $5)
     on conflict (entity_kind, retired_id) do update set surviving_id = excluded.surviving_id, correction_id = excluded.correction_id`,
    [scope.projectId, kind, retiredId, survivingId, scope.correctionId],
  );
}

async function split(scope: Scope, correction: Extract<Correction, { kind: "split" }>): Promise<string> {
  const item = await activeWorkItem(scope, correction.workItemId);
  const { client } = scope;
  const linkedEvidence = await client.query<{ evidence_id: string; artifact_id: string | null }>(
    `select we.evidence_id, e.artifact_id from work_item_evidence we
     join evidence e on e.id = we.evidence_id
     where we.work_item_id = $1`,
    [item.id],
  );
  const linkedArtifacts = await client.query<{ artifact_id: string }>(
    `select artifact_id from work_item_artifacts where work_item_id = $1`,
    [item.id],
  );
  const evidenceIds = new Set(correction.evidenceIds);
  const artifactIds = new Set(correction.artifactIds);
  for (const row of linkedEvidence.rows) {
    if (evidenceIds.has(row.evidence_id) && row.artifact_id) {
      artifactIds.add(row.artifact_id);
    }
    if (row.artifact_id && artifactIds.has(row.artifact_id)) {
      evidenceIds.add(row.evidence_id);
    }
  }
  const knownEvidence = new Set(linkedEvidence.rows.map((row) => row.evidence_id));
  const knownArtifacts = new Set(linkedArtifacts.rows.map((row) => row.artifact_id));
  if (evidenceIds.size + artifactIds.size === 0) {
    throw new CorrectionError("invalid", "Choose at least one piece of evidence or pull request to split out.");
  }
  if ([...evidenceIds].some((value) => !knownEvidence.has(value)) || [...artifactIds].some((value) => !knownArtifacts.has(value))) {
    throw new CorrectionError("invalid", "Only evidence and pull requests attached to this work item can be split out.");
  }
  if (evidenceIds.size === knownEvidence.size && artifactIds.size === knownArtifacts.size) {
    throw new CorrectionError("invalid", "Leave at least one piece of evidence or pull request on the original work item.");
  }

  const created = await client.query<{ id: string }>(
    `insert into work_items (project_id, feature_id, feature_basis, title, title_basis, summary, summary_basis, state, state_basis)
     values ($1, $2, 'inferred', $3, 'human', $4, 'inferred', 'unknown', 'inferred')
     returning id`,
    [scope.projectId, item.feature_id, correction.title, `Split out from "${item.title}".`],
  );
  const newId = created.rows[0]?.id;
  if (!newId) {
    throw new Error("Work item insert did not return an id.");
  }
  await client.query(
    `insert into work_item_evidence (work_item_id, evidence_id, basis)
     select $1, unnest($2::uuid[]), 'human'`,
    [newId, [...evidenceIds]],
  );
  await client.query(
    `insert into work_item_artifacts (work_item_id, artifact_id, basis, evidence_ids)
     select $2, wa.artifact_id, 'human', wa.evidence_ids from work_item_artifacts wa
     where wa.work_item_id = $1 and wa.artifact_id = any($3::uuid[])`,
    [item.id, newId, [...artifactIds]],
  );
  await client.query(`delete from work_item_evidence where work_item_id = $1 and evidence_id = any($2::uuid[])`, [item.id, [...evidenceIds]]);
  await client.query(`delete from work_item_artifacts where work_item_id = $1 and artifact_id = any($2::uuid[])`, [item.id, [...artifactIds]]);
  await client.query(
    `insert into link_blocks (work_item_id, target_kind, target_id, correction_id)
     select $1::uuid, 'evidence'::text, unnest($2::uuid[]), $4::uuid
     union all
     select $1::uuid, 'artifact'::text, unnest($3::uuid[]), $4::uuid
     on conflict do nothing`,
    [item.id, [...evidenceIds], [...artifactIds], scope.correctionId],
  );
  await recomputeWorkItemStates(client, [item.id, newId], scope.changes, new Set([newId]));
  const state = await client.query<{ state: string; state_basis: string }>(`select state, state_basis from work_items where id = $1`, [newId]);
  scope.changes.add({
    entityKind: "work_item",
    entityId: item.id,
    change: "split",
    before: null,
    after: { newWorkItemId: newId, evidenceIds: [...evidenceIds], artifactIds: [...artifactIds] },
    basis: "human",
    evidenceIds: [...evidenceIds],
  });
  scope.changes.add({
    entityKind: "work_item",
    entityId: newId,
    change: "created",
    before: null,
    after: { featureId: item.feature_id, title: correction.title, splitFrom: item.id, ...state.rows[0] },
    basis: "human",
    evidenceIds: [...evidenceIds],
  });
  return newId;
}

async function dismiss(scope: Scope, relationshipId: string): Promise<void> {
  const result = await scope.client.query<{ id: string; from_work_item_id: string; to_work_item_id: string; dismissed_at: Date | null }>(
    `select id, from_work_item_id, to_work_item_id, dismissed_at from relationships
     where id = $1 and project_id = $2
     for update`,
    [relationshipId, scope.projectId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CorrectionError("not_found", "Relationship not found.");
  }
  if (row.dismissed_at !== null) {
    return;
  }
  await scope.client.query(`update relationships set dismissed_at = now() where id = $1`, [row.id]);
  scope.changes.add({
    entityKind: "relationship",
    entityId: row.id,
    change: "dismissed",
    before: { from: row.from_work_item_id, to: row.to_work_item_id },
    after: null,
    basis: "human",
    evidenceIds: [],
  });
}
