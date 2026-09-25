import type { Pool } from "pg";
import { SCHEMA_VERSION, normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import {
  applyPullRequestSnapshot,
  applyWorkflowSnapshot,
  pullRequestNumbersForHead,
  savePullRequestObservation,
  saveWorkflowObservation,
} from "./github-enrich.js";
import { insertEvents, type GithubLookup } from "./store.js";

export const refreshLimits = {
  pullRequestsPerRun: 50,
  workflowRunsPerRun: 50,
  pullRequestMaxAgeDays: 30,
  workflowRunMaxAgeHours: 24,
};

export type RefreshResult = {
  checked: number;
  eventsStored: number;
};

type ObservationRow = {
  project_id: string;
  source_id: string;
  head_sha: string | null;
  updated_at: Date;
  state: Record<string, unknown>;
  github_repo_id: string;
  github_owner: string;
  github_name: string;
};

/** Re-reads open pull requests and unfinished workflow runs so a missed webhook does not leave them stale. */
export async function refreshObservedGithub(
  pool: Pool,
  github: GithubLookup,
  options: { projectId?: string } = {},
): Promise<RefreshResult> {
  const projectId = options.projectId ?? null;
  const pullRequests = await refreshPullRequests(pool, github, projectId);
  const runs = await refreshWorkflowRuns(pool, github, projectId);
  return {
    checked: pullRequests.checked + runs.checked,
    eventsStored: pullRequests.eventsStored + runs.eventsStored,
  };
}

async function refreshPullRequests(pool: Pool, github: GithubLookup, projectId: string | null): Promise<RefreshResult> {
  const rows = await pool.query<ObservationRow>(
    `select o.project_id, o.source_id, o.head_sha, o.updated_at, o.state,
            p.github_repo_id, p.github_owner, p.github_name
     from github_observations o
     join projects p on p.id = o.project_id
     where o.kind = 'pull_request'
       and o.merged is not true
       and o.state->>'state' = 'open'
       and o.updated_at > now() - make_interval(days => $1)
       and ($3::uuid is null or o.project_id = $3::uuid)
     order by o.updated_at desc
     limit $2`,
    [refreshLimits.pullRequestMaxAgeDays, refreshLimits.pullRequestsPerRun, projectId],
  );
  let eventsStored = 0;
  for (const row of rows.rows) {
    const number = row.state.number;
    if (typeof number !== "number") {
      continue;
    }
    const snapshot = await github.enrichPullRequest(row.github_owner, row.github_name, number);
    if (!snapshot || Date.parse(snapshot.updatedAt) <= row.updated_at.getTime()) {
      continue;
    }
    const base = normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: `github:refresh:pull_request:${row.source_id}:${snapshot.updatedAt}`,
      sourceKey: `github:pull_request:${row.source_id}:${snapshot.updatedAt}`,
      projectId: row.project_id,
      source: "github",
      occurredAt: snapshot.updatedAt,
      details: {
        kind: "pr.updated",
        repositoryId: Number(row.github_repo_id),
        pullRequestId: Number(row.source_id),
        number,
        title: snapshot.title,
        body: snapshot.body,
        url: snapshot.url,
        draft: snapshot.draft,
        state: snapshot.state,
        merged: snapshot.merged,
        headSha: snapshot.headSha,
        updatedAt: snapshot.updatedAt,
      },
    });
    eventsStored += await storeRefreshedEvent(pool, row.project_id, applyPullRequestSnapshot(base, snapshot));
  }
  return { checked: rows.rows.length, eventsStored };
}

async function refreshWorkflowRuns(pool: Pool, github: GithubLookup, projectId: string | null): Promise<RefreshResult> {
  const rows = await pool.query<ObservationRow>(
    `select o.project_id, o.source_id, o.head_sha, o.updated_at, o.state,
            p.github_repo_id, p.github_owner, p.github_name
     from github_observations o
     join projects p on p.id = o.project_id
     where o.kind = 'workflow_run'
       and o.state->>'status' <> 'completed'
       and o.updated_at > now() - make_interval(hours => $1)
       and ($3::uuid is null or o.project_id = $3::uuid)
     order by o.updated_at desc
     limit $2`,
    [refreshLimits.workflowRunMaxAgeHours, refreshLimits.workflowRunsPerRun, projectId],
  );
  let eventsStored = 0;
  for (const row of rows.rows) {
    const runId = row.state.runId;
    if (typeof runId !== "number") {
      continue;
    }
    const snapshot = await github.enrichWorkflowRun(row.github_owner, row.github_name, runId);
    if (!snapshot || Date.parse(snapshot.updatedAt) <= row.updated_at.getTime()) {
      continue;
    }
    if (snapshot.pullRequestNumbers.length === 0) {
      const matched = await pullRequestNumbersForHead(pool, row.project_id, snapshot.headSha);
      if (matched.length === 1) {
        snapshot.pullRequestNumbers = matched;
      }
    }
    const base = normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: `github:refresh:workflow_run:${runId}:${snapshot.attempt}:${snapshot.updatedAt}`,
      sourceKey: `github:workflow_run:${runId}:${snapshot.attempt}:${snapshot.updatedAt}`,
      projectId: row.project_id,
      source: "github",
      occurredAt: snapshot.updatedAt,
      details: { ...row.state, kind: "workflow.updated", jobId: null },
    });
    eventsStored += await storeRefreshedEvent(pool, row.project_id, applyWorkflowSnapshot(base, snapshot));
  }
  return { checked: rows.rows.length, eventsStored };
}

async function storeRefreshedEvent(pool: Pool, projectId: string, event: NormalizedEvent): Promise<number> {
  const stored = await insertEvents(pool, [event]);
  await savePullRequestObservation(pool, projectId, event);
  await saveWorkflowObservation(pool, projectId, event);
  return stored;
}
