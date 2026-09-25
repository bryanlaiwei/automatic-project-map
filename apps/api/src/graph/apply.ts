import type { PoolClient } from "pg";
import type { ContextEvidence, InterpretationContext } from "./context.js";
import { ChangeSet, recomputeWorkItemStates, resolveAlias } from "./graph-store.js";
import { proposalLimits, type Proposal, type ProposalOperation } from "./proposal.js";
import type { Basis, InferredState, WorkItemState } from "./state.js";

export type OperationOutcome =
  | { index: number; op: ProposalOperation["op"]; status: "applied" | "unchanged"; notes: string[] }
  | { index: number; op: ProposalOperation["op"]; status: "rejected"; reason: string };

export type ApplyResult = {
  outcomes: OperationOutcome[];
  citedEvidenceIds: Set<string>;
};

type WorkItemRow = {
  id: string;
  feature_id: string;
  feature_basis: Basis;
  title: string;
  title_basis: Basis;
  summary: string;
  summary_basis: Basis;
  state: WorkItemState;
  state_basis: Basis;
  inferred_state: InferredState | null;
  blocked: boolean;
  blocked_reason: string | null;
};

type FeatureRow = {
  id: string;
  title: string;
  title_basis: Basis;
  summary: string;
  summary_basis: Basis;
};

class Rejected extends Error {}

/**
 * Checks each proposed operation against the current records and applies the valid ones. A rejected
 * operation leaves no partial writes. Model text never chooses ids: every reference is an alias from the
 * context or a ref created earlier in the same proposal.
 */
export async function applyProposal(input: {
  client: PoolClient;
  projectId: string;
  context: InterpretationContext;
  proposal: Proposal;
  changes: ChangeSet;
}): Promise<ApplyResult> {
  const applier = new ProposalApplier(input.client, input.projectId, input.context, input.changes);
  return applier.run(input.proposal);
}

class ProposalApplier {
  private readonly evidence: Map<string, ContextEvidence>;
  private readonly workItemAliases: Map<string, string>;
  private readonly featureAliases: Map<string, string>;
  private readonly created = new Map<string, { kind: "feature" | "work_item"; id: string; index: number }>();
  private readonly createdWorkItems = new Set<string>();
  private readonly touched = new Set<string>();
  private readonly cited = new Set<string>();

  constructor(
    private readonly client: PoolClient,
    private readonly projectId: string,
    context: InterpretationContext,
    private readonly changes: ChangeSet,
  ) {
    this.evidence = new Map(context.evidence.map((item) => [item.alias, item]));
    this.workItemAliases = new Map(context.workItems.map((item) => [item.alias, item.id]));
    this.featureAliases = new Map(context.features.map((item) => [item.alias, item.id]));
  }

  async run(proposal: Proposal): Promise<ApplyResult> {
    const outcomes: OperationOutcome[] = [];
    for (const [index, operation] of proposal.operations.slice(0, proposalLimits.operations).entries()) {
      await this.client.query("savepoint proposal_operation");
      const pending = this.changes.items.length;
      try {
        const notes: string[] = [];
        const changed = await this.apply(operation, index, notes);
        await this.client.query("release savepoint proposal_operation");
        outcomes.push({ index, op: operation.op, status: changed ? "applied" : "unchanged", notes });
        if (changed) {
          for (const alias of operation.evidence) {
            const item = this.evidence.get(alias);
            if (item) {
              this.cited.add(item.id);
            }
          }
        }
      } catch (error) {
        await this.client.query("rollback to savepoint proposal_operation");
        this.changes.items.splice(pending);
        if (!(error instanceof Rejected)) {
          throw error;
        }
        outcomes.push({ index, op: operation.op, status: "rejected", reason: error.message });
      }
    }

    await this.dropEmptyFeatures(outcomes);
    await recomputeWorkItemStates(this.client, this.touched, this.changes, this.createdWorkItems);
    await this.recordCreatedWorkItems();
    return { outcomes, citedEvidenceIds: this.cited };
  }

  private async apply(operation: ProposalOperation, index: number, notes: string[]): Promise<boolean> {
    switch (operation.op) {
      case "create_feature":
        return this.createFeature(operation, index);
      case "create_work_item":
        return this.createWorkItem(operation, index, notes);
      case "attach":
        return this.attach(operation.work_item, operation.evidence, notes);
      case "update_work_item":
        return this.updateWorkItem(operation, notes);
      case "update_feature":
        return this.updateFeature(operation, notes);
      case "move_work_item":
        return this.moveWorkItem(operation);
      case "add_dependency":
        return this.addDependency(operation);
      case "set_blocked":
        return this.setBlocked(operation);
      default: {
        const unhandled: never = operation;
        throw new Rejected(`unknown operation ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private citedEvidence(aliases: readonly string[]): ContextEvidence[] {
    if (aliases.length === 0) {
      throw new Rejected("no_supporting_evidence");
    }
    return [...new Set(aliases)].map((alias) => {
      const item = this.evidence.get(alias);
      if (!item) {
        throw new Rejected(`unknown_evidence:${alias}`);
      }
      return item;
    });
  }

  private checkedState(state: InferredState | null, evidence: readonly ContextEvidence[], notes: string[]): InferredState | null {
    if (state === "planned" && !evidence.some((item) => item.hasUserMessage)) {
      notes.push("planned_needs_a_recorded_request");
      return null;
    }
    return state;
  }

  private newRef(ref: string): string {
    if (!ref.startsWith("new:") || ref.length <= 4) {
      throw new Rejected(`invalid_ref:${ref}`);
    }
    if (this.created.has(ref)) {
      throw new Rejected(`duplicate_ref:${ref}`);
    }
    return ref;
  }

  private async resolveFeature(ref: string): Promise<FeatureRow> {
    const createdRef = this.created.get(ref);
    const rawId = createdRef?.kind === "feature" ? createdRef.id : this.featureAliases.get(ref);
    if (!rawId) {
      throw new Rejected(`unknown_feature:${ref}`);
    }
    const id = await resolveAlias(this.client, "feature", rawId);
    const result = await this.client.query<FeatureRow>(
      `select id, title, title_basis, summary, summary_basis from feature_groups
       where id = $1 and project_id = $2 and retired_into is null
       for update`,
      [id, this.projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Rejected(`feature_not_found:${ref}`);
    }
    return row;
  }

  private async resolveWorkItem(ref: string): Promise<WorkItemRow> {
    const createdRef = this.created.get(ref);
    const rawId = createdRef?.kind === "work_item" ? createdRef.id : this.workItemAliases.get(ref);
    if (!rawId) {
      throw new Rejected(`unknown_work_item:${ref}`);
    }
    const id = await resolveAlias(this.client, "work_item", rawId);
    const result = await this.client.query<WorkItemRow>(
      `select id, feature_id, feature_basis, title, title_basis, summary, summary_basis, state, state_basis,
              inferred_state, blocked, blocked_reason
       from work_items
       where id = $1 and project_id = $2 and retired_into is null
       for update`,
      [id, this.projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Rejected(`work_item_not_found:${ref}`);
    }
    return row;
  }

  private async createFeature(operation: Extract<ProposalOperation, { op: "create_feature" }>, index: number): Promise<boolean> {
    const ref = this.newRef(operation.ref);
    this.citedEvidence(operation.evidence);
    const title = cleanTitle(operation.title);
    const result = await this.client.query<{ id: string }>(
      `insert into feature_groups (project_id, title, title_basis, summary, summary_basis)
       values ($1, $2, 'inferred', $3, 'inferred') returning id`,
      [this.projectId, title, cleanSummary(operation.summary)],
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error("Feature insert did not return an id.");
    }
    this.created.set(ref, { kind: "feature", id, index });
    return true;
  }

  private async createWorkItem(
    operation: Extract<ProposalOperation, { op: "create_work_item" }>,
    index: number,
    notes: string[],
  ): Promise<boolean> {
    const ref = this.newRef(operation.ref);
    const evidence = this.citedEvidence(operation.evidence);
    const feature = await this.resolveFeature(operation.feature);
    const state = this.checkedState(operation.state, evidence, notes);
    const result = await this.client.query<{ id: string }>(
      `insert into work_items
         (project_id, feature_id, feature_basis, title, title_basis, summary, summary_basis, state, state_basis,
          inferred_state, inferred_state_at)
       values ($1, $2, 'inferred', $3, 'inferred', $4, 'inferred', 'unknown', 'inferred', $5, $6)
       returning id`,
      [this.projectId, feature.id, cleanTitle(operation.title), cleanSummary(operation.summary), state, state ? latest(evidence) : null],
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error("Work item insert did not return an id.");
    }
    this.created.set(ref, { kind: "work_item", id, index });
    this.createdWorkItems.add(id);
    this.touched.add(id);
    await this.link(id, evidence, notes);
    return true;
  }

  private async attach(workItemRef: string, aliases: readonly string[], notes: string[]): Promise<boolean> {
    const item = await this.resolveWorkItem(workItemRef);
    const evidence = this.citedEvidence(aliases);
    const linked = await this.attachAndRecord(item.id, evidence, notes);
    if (linked.added.length === 0 && linked.blocked === evidence.length) {
      throw new Rejected("blocked_by_correction");
    }
    return linked.added.length > 0;
  }

  private async attachAndRecord(
    workItemId: string,
    evidence: readonly ContextEvidence[],
    notes: string[],
  ): Promise<{ added: string[]; blocked: number }> {
    const linked = await this.link(workItemId, evidence, notes);
    if (linked.added.length > 0 && !this.createdWorkItems.has(workItemId)) {
      this.touched.add(workItemId);
      this.changes.add({
        entityKind: "work_item",
        entityId: workItemId,
        change: "evidence_attached",
        before: null,
        after: { evidenceIds: linked.added },
        basis: "inferred",
        evidenceIds: linked.added,
      });
    }
    return linked;
  }

  /** Links evidence, and the pull request behind pull request evidence, unless a person separated them. */
  private async link(
    workItemId: string,
    evidence: readonly ContextEvidence[],
    notes: string[],
  ): Promise<{ added: string[]; blocked: number }> {
    const added: string[] = [];
    let blockedCount = 0;
    for (const item of evidence) {
      const blocked = await this.client.query(
        `select 1 from link_blocks
         where work_item_id = $1
           and ((target_kind = 'evidence' and target_id = $2) or (target_kind = 'artifact' and target_id = $3))`,
        [workItemId, item.id, item.artifactId],
      );
      if ((blocked.rowCount ?? 0) > 0) {
        blockedCount += 1;
        notes.push(`blocked_by_correction:${item.alias}`);
        continue;
      }
      const inserted = await this.client.query(
        `insert into work_item_evidence (work_item_id, evidence_id, basis) values ($1, $2, 'inferred')
         on conflict do nothing`,
        [workItemId, item.id],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        added.push(item.id);
      }
      if (item.artifactId) {
        await this.client.query(
          `insert into work_item_artifacts (work_item_id, artifact_id, basis, evidence_ids)
           values ($1, $2, 'inferred', array[$3]::uuid[])
           on conflict (work_item_id, artifact_id) do update
             set evidence_ids = (select array_agg(distinct value) from unnest(work_item_artifacts.evidence_ids || excluded.evidence_ids) value)`,
          [workItemId, item.artifactId, item.id],
        );
      }
    }
    return { added, blocked: blockedCount };
  }

  private async updateWorkItem(operation: Extract<ProposalOperation, { op: "update_work_item" }>, notes: string[]): Promise<boolean> {
    const item = await this.resolveWorkItem(operation.work_item);
    const evidence = this.citedEvidence(operation.evidence);
    const evidenceIds = evidence.map((entry) => entry.id);
    let changed = (await this.attachAndRecord(item.id, evidence, notes)).added.length > 0;

    const title = operation.title === null ? null : cleanTitle(operation.title);
    if (title !== null && title !== item.title) {
      if (item.title_basis === "human") {
        notes.push("title_set_by_person");
      } else {
        await this.client.query(`update work_items set title = $2, title_basis = 'inferred', updated_at = now() where id = $1`, [item.id, title]);
        this.recordWorkItemChange(item.id, "title", item.title, title, evidenceIds);
        changed = true;
      }
    }
    const summary = operation.summary === null ? null : cleanSummary(operation.summary);
    if (summary !== null && summary !== item.summary) {
      if (item.summary_basis === "human") {
        notes.push("summary_set_by_person");
      } else {
        await this.client.query(`update work_items set summary = $2, summary_basis = 'inferred', updated_at = now() where id = $1`, [item.id, summary]);
        this.recordWorkItemChange(item.id, "summary", item.summary, summary, evidenceIds);
        changed = true;
      }
    }
    const state = this.checkedState(operation.state, evidence, notes);
    if (state !== null) {
      await this.client.query(`update work_items set inferred_state = $2, inferred_state_at = $3 where id = $1`, [
        item.id,
        state,
        latest(evidence),
      ]);
      this.touched.add(item.id);
    }
    if (changed) {
      this.touched.add(item.id);
    }
    return changed || state !== null;
  }

  private recordWorkItemChange(id: string, field: string, before: string, after: string, evidenceIds: string[]): void {
    if (this.createdWorkItems.has(id)) {
      return;
    }
    this.changes.add({
      entityKind: "work_item",
      entityId: id,
      change: field,
      before: { [field]: before },
      after: { [field]: after },
      basis: "inferred",
      evidenceIds,
    });
  }

  private async updateFeature(operation: Extract<ProposalOperation, { op: "update_feature" }>, notes: string[]): Promise<boolean> {
    const feature = await this.resolveFeature(operation.feature);
    const evidenceIds = this.citedEvidence(operation.evidence).map((entry) => entry.id);
    const createdHere = [...this.created.values()].some((entry) => entry.kind === "feature" && entry.id === feature.id);
    let changed = false;
    for (const field of ["title", "summary"] as const) {
      const raw = operation[field];
      if (raw === null) {
        continue;
      }
      const value = field === "title" ? cleanTitle(raw) : cleanSummary(raw);
      if (value === feature[field]) {
        continue;
      }
      if (feature[`${field}_basis`] === "human") {
        notes.push(`${field}_set_by_person`);
        continue;
      }
      await this.client.query(`update feature_groups set ${field} = $2, ${field}_basis = 'inferred', updated_at = now() where id = $1`, [
        feature.id,
        value,
      ]);
      if (!createdHere) {
        this.changes.add({
          entityKind: "feature",
          entityId: feature.id,
          change: field,
          before: { [field]: feature[field] },
          after: { [field]: value },
          basis: "inferred",
          evidenceIds,
        });
      }
      changed = true;
    }
    return changed;
  }

  private async moveWorkItem(operation: Extract<ProposalOperation, { op: "move_work_item" }>): Promise<boolean> {
    const item = await this.resolveWorkItem(operation.work_item);
    const evidenceIds = this.citedEvidence(operation.evidence).map((entry) => entry.id);
    const feature = await this.resolveFeature(operation.feature);
    if (feature.id === item.feature_id) {
      return false;
    }
    if (item.feature_basis === "human") {
      throw new Rejected("placement_set_by_person");
    }
    await this.client.query(`update work_items set feature_id = $2, feature_basis = 'inferred', updated_at = now() where id = $1`, [
      item.id,
      feature.id,
    ]);
    if (!this.createdWorkItems.has(item.id)) {
      this.changes.add({
        entityKind: "work_item",
        entityId: item.id,
        change: "moved",
        before: { featureId: item.feature_id },
        after: { featureId: feature.id },
        basis: "inferred",
        evidenceIds,
      });
    }
    return true;
  }

  private async addDependency(operation: Extract<ProposalOperation, { op: "add_dependency" }>): Promise<boolean> {
    const from = await this.resolveWorkItem(operation.from);
    const to = await this.resolveWorkItem(operation.to);
    const evidenceIds = this.citedEvidence(operation.evidence).map((entry) => entry.id);
    if (from.id === to.id) {
      throw new Rejected("dependency_on_itself");
    }
    const existing = await this.client.query<{ from_work_item_id: string; dismissed_at: Date | null }>(
      `select from_work_item_id, dismissed_at from relationships
       where kind = 'depends_on'
         and ((from_work_item_id = $1 and to_work_item_id = $2) or (from_work_item_id = $2 and to_work_item_id = $1))`,
      [from.id, to.id],
    );
    if (existing.rows.some((row) => row.dismissed_at !== null)) {
      throw new Rejected("dismissed_by_person");
    }
    if (existing.rows.some((row) => row.from_work_item_id === to.id)) {
      throw new Rejected("would_create_a_cycle");
    }
    if (existing.rows.length > 0) {
      return false;
    }
    const inserted = await this.client.query<{ id: string }>(
      `insert into relationships (project_id, kind, from_work_item_id, to_work_item_id, basis, evidence_ids)
       values ($1, 'depends_on', $2, $3, 'inferred', $4::uuid[]) returning id`,
      [this.projectId, from.id, to.id, evidenceIds],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      throw new Error("Relationship insert did not return an id.");
    }
    this.changes.add({
      entityKind: "relationship",
      entityId: id,
      change: "created",
      before: null,
      after: { kind: "depends_on", from: from.id, to: to.id },
      basis: "inferred",
      evidenceIds,
    });
    return true;
  }

  private async setBlocked(operation: Extract<ProposalOperation, { op: "set_blocked" }>): Promise<boolean> {
    const item = await this.resolveWorkItem(operation.work_item);
    const evidenceIds = this.citedEvidence(operation.evidence).map((entry) => entry.id);
    const reason = operation.blocked ? truncateText((operation.reason ?? "").trim(), proposalLimits.reasonChars) || null : null;
    if (operation.blocked && reason === null) {
      throw new Rejected("blocked_needs_a_reason");
    }
    if (item.blocked === operation.blocked && item.blocked_reason === reason) {
      return false;
    }
    await this.client.query(`update work_items set blocked = $2, blocked_reason = $3, updated_at = now() where id = $1`, [
      item.id,
      operation.blocked,
      reason,
    ]);
    if (!this.createdWorkItems.has(item.id)) {
      this.changes.add({
        entityKind: "work_item",
        entityId: item.id,
        change: operation.blocked ? "blocked" : "unblocked",
        before: { blocked: item.blocked, reason: item.blocked_reason },
        after: { blocked: operation.blocked, reason },
        basis: "inferred",
        evidenceIds,
      });
    }
    return true;
  }

  /** A feature exists to group work, so one the proposal left empty is not kept. */
  private async dropEmptyFeatures(outcomes: OperationOutcome[]): Promise<void> {
    for (const entry of this.created.values()) {
      if (entry.kind !== "feature") {
        continue;
      }
      const used = await this.client.query(`select 1 from work_items where feature_id = $1 limit 1`, [entry.id]);
      const outcome = outcomes[entry.index];
      if ((used.rowCount ?? 0) === 0) {
        await this.client.query(`delete from feature_groups where id = $1`, [entry.id]);
        if (outcome) {
          outcomes[entry.index] = { index: entry.index, op: outcome.op, status: "rejected", reason: "feature_without_work_items" };
        }
        continue;
      }
      const row = await this.client.query<{ title: string; summary: string }>(`select title, summary from feature_groups where id = $1`, [entry.id]);
      this.changes.add({
        entityKind: "feature",
        entityId: entry.id,
        change: "created",
        before: null,
        after: row.rows[0] ?? null,
        basis: "inferred",
        evidenceIds: [],
      });
    }
  }

  private async recordCreatedWorkItems(): Promise<void> {
    if (this.createdWorkItems.size === 0) {
      return;
    }
    const rows = await this.client.query<{ id: string; feature_id: string; title: string; summary: string; state: string; state_basis: string; evidence_ids: string[] }>(
      `select wi.id, wi.feature_id, wi.title, wi.summary, wi.state, wi.state_basis,
              coalesce((select array_agg(evidence_id) from work_item_evidence where work_item_id = wi.id), '{}') as evidence_ids
       from work_items wi where wi.id = any($1::uuid[])`,
      [[...this.createdWorkItems]],
    );
    for (const row of rows.rows) {
      this.changes.add({
        entityKind: "work_item",
        entityId: row.id,
        change: "created",
        before: null,
        after: { featureId: row.feature_id, title: row.title, summary: row.summary, state: row.state, stateBasis: row.state_basis },
        basis: "inferred",
        evidenceIds: row.evidence_ids,
      });
    }
  }
}

function latest(evidence: readonly ContextEvidence[]): string {
  return evidence.reduce((max, item) => (Date.parse(item.observedAt) > Date.parse(max) ? item.observedAt : max), evidence[0]?.observedAt ?? new Date(0).toISOString());
}

function cleanTitle(value: string): string {
  const title = truncateText(value.replace(/\s+/g, " ").trim(), proposalLimits.titleChars);
  if (title === "") {
    throw new Rejected("empty_title");
  }
  return title;
}

function cleanSummary(value: string): string {
  return truncateText(value.trim(), proposalLimits.summaryChars);
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
