import type { Pool, PoolClient } from "pg";
import { applyProposal, type OperationOutcome } from "./apply.js";
import { buildContext, contextLimits, type InterpretationContext } from "./context.js";
import { applyFactsBatch, type FactsResult } from "./facts.js";
import { ChangeSet, commitChanges, lockProject } from "./graph-store.js";
import type { Proposal } from "./proposal.js";

export type Interpreter = {
  model: string;
  promptVersion: string;
  interpret(context: InterpretationContext): Promise<Proposal>;
};

export const processingDefaults = {
  quietMs: 20_000,
  maxWaitMs: 60_000,
  maxAttempts: 6,
  retryBaseMs: 30_000,
  retryMaxMs: 30 * 60_000,
  interpretationRounds: 10,
};

export type ProcessOptions = {
  interpreter: Interpreter | null;
  now?: () => Date;
  quietMs?: number;
  maxWaitMs?: number;
  log?: (line: string) => void;
};

export type InterpretationOutcome =
  | { batchId: string; status: "applied" | "no_change"; revision: number | null; evidence: number; outcomes: OperationOutcome[] }
  | { batchId: string; status: "failed"; evidence: number; error: string }
  | { batchId: string; status: "superseded"; evidence: number };

export type ProcessResult = {
  busy: boolean;
  facts: FactsResult[];
  interpretations: InterpretationOutcome[];
  waitingEvidence: number;
};

export async function processProject(pool: Pool, projectId: string, options: ProcessOptions): Promise<ProcessResult> {
  const result: ProcessResult = { busy: false, facts: [], interpretations: [], waitingEvidence: 0 };
  const lockClient = await pool.connect();
  try {
    const locked = await lockClient.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1, 0)) as locked`,
      [`apm:project:${projectId}`],
    );
    if (!locked.rows[0]?.locked) {
      return { ...result, busy: true };
    }
    try {
      await abandonRunningBatches(pool, projectId);
      for (;;) {
        const facts = await inTransaction(pool, async (client) => {
          const project = await lockProject(client, projectId);
          return project ? applyFactsBatch(client, project) : null;
        });
        if (!facts) {
          break;
        }
        result.facts.push(facts);
      }
      if (options.interpreter) {
        for (let round = 0; round < processingDefaults.interpretationRounds; round += 1) {
          const outcome = await interpretReadyEvidence(pool, projectId, options.interpreter, options);
          if (!outcome) {
            break;
          }
          result.interpretations.push(outcome);
          if (outcome.status === "failed") {
            break;
          }
        }
      }
      result.waitingEvidence = await countWaitingEvidence(pool, projectId);
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [`apm:project:${projectId}`]);
    }
  } finally {
    lockClient.release();
  }
  return result;
}

/** Projects with facts to apply, or evidence whose batching window has closed. */
export async function dueProjects(
  pool: Pool,
  options: { includeInterpretation: boolean; now?: () => Date; quietMs?: number; maxWaitMs?: number },
): Promise<string[]> {
  const at = now(options);
  const result = await pool.query<{ project_id: string }>(
    `select project_id from normalized_events where facts_state = 'pending' group by project_id
     union
     select project_id from evidence
     where $1::boolean
       and (interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at <= $2))
     group by project_id
     having max(created_at) <= $2::timestamptz - make_interval(secs => $3)
         or min(created_at) <= $2::timestamptz - make_interval(secs => $4)
         or bool_or(interpretation_state = 'failed')`,
    [
      options.includeInterpretation,
      at.toISOString(),
      (options.quietMs ?? processingDefaults.quietMs) / 1000,
      (options.maxWaitMs ?? processingDefaults.maxWaitMs) / 1000,
    ],
  );
  return result.rows.map((row) => row.project_id);
}

async function abandonRunningBatches(pool: Pool, projectId: string): Promise<void> {
  await pool.query(
    `update processing_batches
     set status = 'failed', error = 'abandoned: processing stopped before this batch finished', completed_at = now()
     where project_id = $1 and status = 'running'`,
    [projectId],
  );
}

async function readyEvidence(pool: Pool, projectId: string, options: ProcessOptions): Promise<string[]> {
  const at = now(options);
  const rows = await pool.query<{ id: string; created_at: Date; interpretation_state: string }>(
    `select id, created_at, interpretation_state
     from evidence
     where project_id = $1
       and (interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at <= $2))
     order by created_at, id`,
    [projectId, at.toISOString()],
  );
  const first = rows.rows[0];
  const last = rows.rows[rows.rows.length - 1];
  if (!first || !last) {
    return [];
  }
  const quietMs = options.quietMs ?? processingDefaults.quietMs;
  const maxWaitMs = options.maxWaitMs ?? processingDefaults.maxWaitMs;
  const quiet = at.getTime() - last.created_at.getTime() >= quietMs;
  const waitedLongEnough = at.getTime() - first.created_at.getTime() >= maxWaitMs;
  const retrying = rows.rows.some((row) => row.interpretation_state === "failed");
  if (!quiet && !waitedLongEnough && !retrying) {
    return [];
  }
  return rows.rows.slice(0, contextLimits.evidencePerBatch).map((row) => row.id);
}

async function countWaitingEvidence(pool: Pool, projectId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*) from evidence
     where project_id = $1 and (interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at is not null))`,
    [projectId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function interpretReadyEvidence(
  pool: Pool,
  projectId: string,
  interpreter: Interpreter,
  options: ProcessOptions,
): Promise<InterpretationOutcome | null> {
  const evidenceIds = await readyEvidence(pool, projectId, options);
  if (evidenceIds.length === 0) {
    return null;
  }

  const started = await inTransaction(pool, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) {
      return null;
    }
    const attempts = await client.query<{ attempt: number }>(
      `select coalesce(max(interpretation_attempts), 0) + 1 as attempt from evidence where id = any($1::uuid[])`,
      [evidenceIds],
    );
    const batch = await client.query<{ id: string }>(
      `insert into processing_batches
         (project_id, stage, status, evidence_ids, attempt, model, prompt_version, base_revision)
       values ($1, 'interpretation', 'running', $2::uuid[], $3, $4, $5, $6)
       returning id`,
      [projectId, evidenceIds, attempts.rows[0]?.attempt ?? 1, interpreter.model, interpreter.promptVersion, project.revision],
    );
    const batchId = batch.rows[0]?.id;
    if (!batchId) {
      throw new Error("Interpretation batch insert did not return an id.");
    }
    await client.query(`update evidence set interpretation_batch_id = $2 where id = any($1::uuid[])`, [evidenceIds, batchId]);
    return { batchId, context: await buildContext(client, project, evidenceIds) };
  });
  if (!started) {
    return null;
  }
  const { batchId, context } = started;

  let proposal: Proposal;
  try {
    proposal = await interpreter.interpret(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Interpretation failed.";
    await recordFailure(pool, batchId, evidenceIds, message, options);
    options.log?.(`interpretation failed for project ${projectId}: ${message}`);
    return { batchId, status: "failed", evidence: evidenceIds.length, error: message };
  }

  return inTransaction(pool, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) {
      return null;
    }
    if (project.revision !== context.baseRevision && (await correctedSince(client, projectId, context))) {
      await client.query(
        `update processing_batches
         set status = 'failed', error = 'superseded: a correction changed records this proposal was based on',
             proposal = $2::jsonb, completed_at = now()
         where id = $1`,
        [batchId, JSON.stringify(proposal)],
      );
      await client.query(`update evidence set interpretation_batch_id = null where id = any($1::uuid[])`, [evidenceIds]);
      return { batchId, status: "superseded" as const, evidence: evidenceIds.length };
    }

    const changes = new ChangeSet();
    const applied = await applyProposal({ client, projectId, context, proposal, changes });
    const revision = await commitChanges(client, projectId, changes, { batchId });
    const cited = [...applied.citedEvidenceIds];
    await client.query(
      `update evidence
       set interpretation_state = case when id = any($2::uuid[]) then 'applied' else 'no_change' end,
           interpretation_attempts = interpretation_attempts + 1,
           retry_at = null
       where id = any($1::uuid[])`,
      [evidenceIds, cited],
    );
    const status = revision === null ? "no_change" : "applied";
    const rejected = applied.outcomes.filter((outcome) => outcome.status === "rejected" || outcome.notes.length > 0);
    await client.query(
      `update processing_batches
       set status = $2, result_revision = $3, proposal = $4::jsonb, rejected = $5::jsonb, completed_at = now()
       where id = $1`,
      [batchId, status, revision, JSON.stringify(proposal), rejected.length > 0 ? JSON.stringify(rejected) : null],
    );
    return { batchId, status, revision, evidence: evidenceIds.length, outcomes: applied.outcomes };
  });
}

/** True when a person changed a record the proposal was based on after its context was read. */
async function correctedSince(client: PoolClient, projectId: string, context: InterpretationContext): Promise<boolean> {
  const ids = [...context.workItems.map((item) => item.id), ...context.features.map((item) => item.id)];
  if (ids.length === 0) {
    return false;
  }
  const result = await client.query(
    `select 1 from graph_changes
     where project_id = $1 and revision > $2 and correction_id is not null and entity_id = any($3::uuid[])
     limit 1`,
    [projectId, context.baseRevision, ids],
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordFailure(pool: Pool, batchId: string, evidenceIds: string[], message: string, options: ProcessOptions): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `update processing_batches set status = 'failed', error = left($2, 2000), completed_at = now() where id = $1`,
      [batchId, message],
    );
    const rows = await client.query<{ id: string; interpretation_attempts: number }>(
      `update evidence set interpretation_state = 'failed', interpretation_attempts = interpretation_attempts + 1
       where id = any($1::uuid[])
       returning id, interpretation_attempts`,
      [evidenceIds],
    );
    for (const row of rows.rows) {
      const retryAt =
        row.interpretation_attempts >= processingDefaults.maxAttempts
          ? null
          : new Date(now(options).getTime() + retryDelayMs(row.interpretation_attempts)).toISOString();
      await client.query(`update evidence set retry_at = $2 where id = $1`, [row.id, retryAt]);
    }
  });
}

export function retryDelayMs(attempts: number): number {
  return Math.min(processingDefaults.retryBaseMs * 2 ** Math.max(0, attempts - 1), processingDefaults.retryMaxMs);
}

function now(options: { now?: () => Date }): Date {
  return options.now?.() ?? new Date();
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
