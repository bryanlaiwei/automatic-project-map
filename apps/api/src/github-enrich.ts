import { normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import type { Pool } from "pg";
import { signGithubAppJwt } from "./github-app.js";

type JsonRecord = Record<string, unknown>;

export type PullRequestSnapshot = {
  title: string;
  body: string;
  url: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  updatedAt: string;
  commits: Array<{ sha: string; message: string }>;
  files: Array<{ filename: string; status: string }>;
};

export type WorkflowSnapshot = {
  status: string;
  conclusion: string | null;
  headSha: string;
  attempt: number;
  url: string;
  updatedAt: string;
  pullRequestNumbers: number[];
  jobs: Array<{ jobId: number; name: string; status: string; conclusion: string | null; attempt: number }>;
};

export function applyPullRequestSnapshot(event: NormalizedEvent, snapshot: PullRequestSnapshot): NormalizedEvent {
  if (event.details.kind !== "pr.updated") {
    return event;
  }
  return normalizedEventSchema.parse({
    ...event,
    occurredAt: snapshot.updatedAt,
    details: {
      ...event.details,
      title: snapshot.title,
      body: snapshot.body,
      url: snapshot.url,
      draft: snapshot.draft,
      state: snapshot.state,
      merged: snapshot.merged,
      headSha: snapshot.headSha,
      updatedAt: snapshot.updatedAt,
      commits: snapshot.commits,
      files: snapshot.files,
    },
  });
}

export function applyWorkflowSnapshot(event: NormalizedEvent, snapshot: WorkflowSnapshot): NormalizedEvent {
  if (event.details.kind !== "workflow.updated" || event.details.jobId !== null) {
    return event;
  }
  return normalizedEventSchema.parse({
    ...event,
    occurredAt: snapshot.updatedAt,
    details: {
      ...event.details,
      status: snapshot.status,
      conclusion: snapshot.conclusion,
      headSha: snapshot.headSha,
      attempt: snapshot.attempt,
      url: snapshot.url,
      pullRequestNumbers: snapshot.pullRequestNumbers,
      jobs: snapshot.jobs,
    },
  });
}

/**
 * A delivery that still says "open" must not clear a merge we already stored
 * at the same or a later source time.
 */
export function preserveKnownMerge(snapshot: PullRequestSnapshot, known: { merged: boolean; updatedAt: string } | null): PullRequestSnapshot {
  if (!known?.merged || snapshot.merged) {
    return snapshot;
  }
  if (Date.parse(snapshot.updatedAt) > Date.parse(known.updatedAt)) {
    return snapshot;
  }
  return { ...snapshot, merged: true, state: "closed" };
}

export async function readKnownMerge(
  pool: Pool,
  projectId: string,
  pullRequestId: number,
): Promise<{ merged: boolean; updatedAt: string } | null> {
  const result = await pool.query<{ merged: boolean | null; updated_at: Date }>(
    `select merged, updated_at
     from github_observations
     where project_id = $1 and kind = 'pull_request' and source_id = $2`,
    [projectId, String(pullRequestId)],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { merged: row.merged === true, updatedAt: row.updated_at.toISOString() };
}

export async function savePullRequestObservation(pool: Pool, projectId: string, event: NormalizedEvent): Promise<void> {
  if (event.details.kind !== "pr.updated") {
    return;
  }
  await pool.query(
    `insert into github_observations (project_id, kind, source_id, head_sha, updated_at, merged, state)
     values ($1, 'pull_request', $2, $3, $4, $5, $6::jsonb)
     on conflict (project_id, kind, source_id) do update
       set head_sha = excluded.head_sha,
           updated_at = excluded.updated_at,
           merged = excluded.merged,
           state = excluded.state
       where github_observations.updated_at <= excluded.updated_at
          or (github_observations.merged is not true and excluded.merged is true)`,
    [
      projectId,
      String(event.details.pullRequestId),
      event.details.headSha,
      event.details.updatedAt,
      event.details.merged,
      JSON.stringify({
        number: event.details.number,
        title: event.details.title,
        state: event.details.state,
        draft: event.details.draft,
        merged: event.details.merged,
        url: event.details.url,
      }),
    ],
  );
}

export async function saveWorkflowObservation(pool: Pool, projectId: string, event: NormalizedEvent): Promise<void> {
  if (event.details.kind !== "workflow.updated") {
    return;
  }
  const sourceId = event.details.jobId === null ? `run:${event.details.runId}` : `job:${event.details.jobId}`;
  const kind = event.details.jobId === null ? "workflow_run" : "workflow_job";
  await pool.query(
    `insert into github_observations (project_id, kind, source_id, head_sha, updated_at, merged, state)
     values ($1, $2, $3, $4, $5, null, $6::jsonb)
     on conflict (project_id, kind, source_id) do update
       set head_sha = excluded.head_sha,
           updated_at = excluded.updated_at,
           state = excluded.state
       where github_observations.updated_at <= excluded.updated_at`,
    [
      projectId,
      kind,
      sourceId,
      event.details.headSha,
      event.occurredAt,
      JSON.stringify(event.details),
    ],
  );
}

export async function pullRequestNumbersForHead(
  pool: Pool,
  projectId: string,
  headSha: string,
): Promise<number[]> {
  if (headSha === "" || headSha === "unknown") {
    return [];
  }
  const result = await pool.query<{ number: number }>(
    `select distinct (state->>'number')::int as number
     from github_observations
     where project_id = $1 and kind = 'pull_request' and head_sha = $2`,
    [projectId, headSha],
  );
  return result.rows.map((row) => row.number).filter((number) => Number.isInteger(number));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function snapshotFromPullRequest(body: unknown, commitsBody: unknown, filesBody: unknown): PullRequestSnapshot | null {
  if (!isRecord(body) || typeof body.id !== "number") {
    return null;
  }
  const updatedAt = asString(body.updated_at);
  const head = isRecord(body.head) ? asString(body.head.sha) : null;
  if (!updatedAt || !head || Number.isNaN(Date.parse(updatedAt))) {
    return null;
  }
  return {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
    url: typeof body.html_url === "string" ? body.html_url : "https://github.com",
    draft: body.draft === true,
    state: body.state === "closed" ? "closed" : "open",
    merged: typeof body.merged_at === "string" || body.merged === true,
    headSha: head,
    updatedAt: new Date(updatedAt).toISOString(),
    commits: readCommits(commitsBody),
    files: readFiles(filesBody),
  };
}

export function snapshotFromWorkflow(runBody: unknown, jobsBody: unknown): WorkflowSnapshot | null {
  if (!isRecord(runBody) || typeof runBody.id !== "number") {
    return null;
  }
  const updatedAt = asString(runBody.updated_at);
  const headSha = asString(runBody.head_sha);
  if (!updatedAt || !headSha || Number.isNaN(Date.parse(updatedAt))) {
    return null;
  }
  const pullRequestNumbers = Array.isArray(runBody.pull_requests)
    ? runBody.pull_requests.flatMap((item) => (isRecord(item) && typeof item.number === "number" ? [item.number] : []))
    : [];
  return {
    status: typeof runBody.status === "string" ? runBody.status : "unknown",
    conclusion: typeof runBody.conclusion === "string" ? runBody.conclusion : null,
    headSha,
    attempt: typeof runBody.run_attempt === "number" ? runBody.run_attempt : 1,
    url: typeof runBody.html_url === "string" ? runBody.html_url : "https://github.com",
    updatedAt: new Date(updatedAt).toISOString(),
    pullRequestNumbers,
    jobs: readJobs(jobsBody),
  };
}

function readCommits(body: unknown): Array<{ sha: string; message: string }> {
  if (!Array.isArray(body)) {
    return [];
  }
  const commits: Array<{ sha: string; message: string }> = [];
  for (const item of body) {
    if (!isRecord(item) || typeof item.sha !== "string") {
      continue;
    }
    const commit = isRecord(item.commit) ? item.commit : null;
    commits.push({ sha: item.sha, message: commit && typeof commit.message === "string" ? commit.message : "" });
  }
  return commits;
}

function readFiles(body: unknown): Array<{ filename: string; status: string }> {
  if (!Array.isArray(body)) {
    return [];
  }
  const files: Array<{ filename: string; status: string }> = [];
  for (const item of body) {
    if (!isRecord(item) || typeof item.filename !== "string" || typeof item.status !== "string") {
      continue;
    }
    files.push({ filename: item.filename, status: item.status });
  }
  return files;
}

function readJobs(body: unknown): WorkflowSnapshot["jobs"] {
  const jobs = isRecord(body) && Array.isArray(body.jobs) ? body.jobs : [];
  const summaries: WorkflowSnapshot["jobs"] = [];
  for (const item of jobs) {
    if (!isRecord(item) || typeof item.id !== "number") {
      continue;
    }
    summaries.push({
      jobId: item.id,
      name: typeof item.name === "string" ? item.name : "",
      status: typeof item.status === "string" ? item.status : "unknown",
      conclusion: typeof item.conclusion === "string" ? item.conclusion : null,
      attempt: typeof item.run_attempt === "number" ? item.run_attempt : 1,
    });
  }
  return summaries;
}

const githubApi = "https://api.github.com";

export function createGithubEnricher(input: {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
}): {
  enrichPullRequest(owner: string, name: string, number: number): Promise<PullRequestSnapshot | null>;
  enrichWorkflowRun(owner: string, name: string, runId: number): Promise<WorkflowSnapshot | null>;
} {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async enrichPullRequest(owner, name, number) {
      const token = await installationToken(fetchImpl, input.appId, input.privateKey, owner, name);
      if (!token) {
        return null;
      }
      const [pull, commits, files] = await Promise.all([
        githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, token),
        githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/commits?per_page=20`, token),
        githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/files?per_page=20`, token),
      ]);
      if (!pull) {
        return null;
      }
      return snapshotFromPullRequest(pull, commits, files);
    },
    async enrichWorkflowRun(owner, name, runId) {
      const token = await installationToken(fetchImpl, input.appId, input.privateKey, owner, name);
      if (!token) {
        return null;
      }
      const [run, jobs] = await Promise.all([
        githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`, token),
        githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}/jobs?per_page=50`, token),
      ]);
      if (!run) {
        return null;
      }
      return snapshotFromWorkflow(run, jobs);
    },
  };
}

async function installationToken(
  fetchImpl: typeof fetch,
  appId: string,
  privateKey: string,
  owner: string,
  name: string,
): Promise<string | null> {
  if (appId.trim() === "" || privateKey.trim() === "") {
    return null;
  }
  try {
    const jwt = signGithubAppJwt(appId.trim(), privateKey);
    const installation = await githubGet(fetchImpl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, jwt);
    const installationId = isRecord(installation) && typeof installation.id === "number" ? installation.id : null;
    if (installationId === null) {
      return null;
    }
    const tokenResponse = await githubPost(fetchImpl, `/app/installations/${installationId}/access_tokens`, jwt);
    return isRecord(tokenResponse) && typeof tokenResponse.token === "string" && tokenResponse.token.length > 0
      ? tokenResponse.token
      : null;
  } catch {
    return null;
  }
}

async function githubGet(fetchImpl: typeof fetch, path: string, token: string): Promise<unknown> {
  const response = await fetchImpl(`${githubApi}${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    return null;
  }
  return response.json().catch(() => null);
}

async function githubPost(fetchImpl: typeof fetch, path: string, token: string): Promise<unknown> {
  const response = await fetchImpl(`${githubApi}${path}`, {
    method: "POST",
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    return null;
  }
  return response.json().catch(() => null);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "automatic-project-map",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
