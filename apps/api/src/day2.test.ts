import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizedEventSchema, SCHEMA_VERSION } from "@apm/shared";
import type { RepositoryAccess } from "./github-app.js";
import { applyPullRequestSnapshot, preserveKnownMerge, snapshotFromPullRequest, snapshotFromWorkflow } from "./github-enrich.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { createApp } = await import("./app.js");
const { getPool } = await import("./db.js");

const userId = "66666666-6666-4666-8666-666666666666";
const secret = "test-webhook-secret";
const repoId = 88000025;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("day 2 collection", () => {
  const pool = getPool();
  let baseUrl = "";
  let projectId = "";
  const pulls = new Map<number, unknown>();
  const runs = new Map<number, { run: unknown; jobs: unknown }>();
  const deps = {
    pool,
    webhookSecret: secret,
    verifyUser: async (token: string) => (token === "day2-user" ? { id: userId } : null),
    verifyRepositoryAccess: async (): Promise<RepositoryAccess> => ({ status: "accessible" }),
    github: {
      async enrichPullRequest(_owner: string, _name: string, number: number) {
        const body = pulls.get(number);
        return body ? snapshotFromPullRequest(body, [], []) : null;
      },
      async enrichWorkflowRun(_owner: string, _name: string, runId: number) {
        const body = runs.get(runId);
        return body ? snapshotFromWorkflow(body.run, body.jobs) : null;
      },
    },
  };
  const server: Server = createApp(deps).listen(0, "127.0.0.1");

  beforeAll(async () => {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    await pool.query("delete from workspaces where name = $1", ["acme/day2"]);
    const connected = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { Authorization: "Bearer day2-user", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "acme", name: "day2", repoId }),
    });
    expect(connected.status).toBe(201);
    const body = (await connected.json()) as { project: { id: string; trackingStartedAt: string } };
    projectId = body.project.id;
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["acme/day2"]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("acks a collector batch once and rejects a pre-project session", async () => {
    const codeResponse = await fetch(`${baseUrl}/projects/${projectId}/collector/pairing-codes`, {
      method: "POST",
      headers: { Authorization: "Bearer day2-user" },
    });
    expect(codeResponse.status).toBe(201);
    const codeBody = (await codeResponse.json()) as { code: string };
    const paired = await fetch(`${baseUrl}/collector/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeBody.code }),
    });
    expect(paired.status).toBe(201);
    const device = (await paired.json()) as { token: string };
    const reused = await fetch(`${baseUrl}/collector/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeBody.code }),
    });
    expect(reused.status).toBe(401);

    const project = await pool.query<{ tracking_started_at: Date }>("select tracking_started_at from projects where id = $1", [
      projectId,
    ]);
    const cutoff = project.rows[0]?.tracking_started_at.toISOString() ?? new Date().toISOString();
    const eligible = event({
      eventId: "codex:day2-session:started",
      createdAt: new Date(Date.parse(cutoff) + 60_000).toISOString(),
      text: null,
    });
    const tooOld = event({
      eventId: "codex:old-session:started",
      createdAt: new Date(Date.parse(cutoff) - 60_000).toISOString(),
      text: null,
    });
    const first = await postEvents(device.token, [eligible, tooOld, { eventId: "not-an-event" }]);
    expect(first.status).toBe(202);
    const acked = (await first.json()) as { acknowledged: string[]; rejected: Array<{ eventId: string; reason: string }> };
    expect(acked.acknowledged).toEqual(["codex:day2-session:started"]);
    expect(acked.rejected.map((item) => item.reason).sort()).toEqual(["created_before_tracking", "invalid_event"]);

    const second = await postEvents(device.token, [eligible]);
    const again = (await second.json()) as { acknowledged: string[] };
    expect(again.acknowledged).toEqual(["codex:day2-session:started"]);
    const stored = await pool.query("select event_id from normalized_events where event_id = $1", ["codex:day2-session:started"]);
    expect(stored.rowCount).toBe(1);

    const revoked = await fetch(`${baseUrl}/collector/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(revoked.status).toBe(204);
    const after = await postEvents(device.token, [eligible]);
    expect(after.status).toBe(401);
  });

  it("enriches a pull request from current GitHub state and keeps a known merge", async () => {
    pulls.set(8, {
      id: 5,
      title: "Current title",
      body: "current body",
      html_url: "https://github.com/acme/day2/pull/8",
      draft: false,
      state: "open",
      merged_at: null,
      updated_at: "2026-09-24T18:00:00.000Z",
      head: { sha: "deadbeef" },
    });
    await pool.query("delete from webhook_deliveries where delivery_id = any($1::text[])", [
      ["day2-pr-current", "day2-pr-late"],
    ]);
    const payload = JSON.stringify({
      repository: { id: repoId },
      pull_request: {
        id: 5,
        number: 8,
        title: "Stale title",
        body: "",
        html_url: "https://github.com/acme/day2/pull/8",
        draft: true,
        state: "open",
        merged_at: null,
        updated_at: "2026-09-24T17:00:00.000Z",
        head: { sha: "old" },
      },
    });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "day2-pr-current",
        "X-Hub-Signature-256": sign(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(202);
    const delivery = await pool.query("select status, note from webhook_deliveries where delivery_id = $1", ["day2-pr-current"]);
    expect(delivery.rows[0]).toMatchObject({ status: "processed" });
    const current = await pool.query<{ details: { title: string; headSha: string; draft: boolean } }>(
      "select details from normalized_events where event_id = $1",
      ["github:day2-pr-current"],
    );
    expect(current.rows[0]?.details.title).toBe("Current title");
    expect(current.rows[0]?.details.headSha).toBe("deadbeef");
    expect(current.rows[0]?.details.draft).toBe(false);

    await pool.query(
      `update github_observations
       set merged = true, updated_at = $2, state = state || '{"merged":true,"state":"closed"}'::jsonb
       where project_id = $1 and kind = 'pull_request' and source_id = '5'`,
      [projectId, "2026-09-24T19:00:00.000Z"],
    );
    pulls.set(8, {
      id: 5,
      title: "Current title",
      body: "current body",
      html_url: "https://github.com/acme/day2/pull/8",
      draft: false,
      state: "open",
      merged_at: null,
      updated_at: "2026-09-24T18:30:00.000Z",
      head: { sha: "deadbeef" },
    });
    const late = payload.replace("Stale title", "Late open");
    const lateResponse = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "day2-pr-late",
        "X-Hub-Signature-256": sign(late),
      },
      body: late,
    });
    expect(lateResponse.status).toBe(202);
    const kept = await pool.query<{ details: { merged: boolean; state: string } }>(
      "select details from normalized_events where event_id = $1",
      ["github:day2-pr-late"],
    );
    expect(kept.rows[0]?.details.merged).toBe(true);
    expect(kept.rows[0]?.details.state).toBe("closed");
  });

  it("links a workflow run to one observed pull request by head sha", async () => {
    runs.set(42, {
      run: {
        id: 42,
        status: "completed",
        conclusion: "success",
        head_sha: "deadbeef",
        run_attempt: 2,
        html_url: "https://github.com/acme/day2/actions/runs/42",
        updated_at: "2026-09-24T20:00:00.000Z",
        pull_requests: [],
      },
      jobs: {
        jobs: [{ id: 7, name: "test", status: "completed", conclusion: "success", run_attempt: 2 }],
      },
    });
    await pool.query("delete from webhook_deliveries where delivery_id = $1", ["day2-run"]);
    const payload = JSON.stringify({
      repository: { id: repoId },
      workflow_run: {
        id: 42,
        status: "queued",
        conclusion: null,
        head_sha: "deadbeef",
        run_attempt: 1,
        html_url: "https://github.com/acme/day2/actions/runs/42",
        updated_at: "2026-09-24T19:30:00.000Z",
        pull_requests: [],
      },
    });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "workflow_run",
        "X-GitHub-Delivery": "day2-run",
        "X-Hub-Signature-256": sign(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(202);
    const stored = await pool.query<{
      details: { status: string; conclusion: string; attempt: number; pullRequestNumbers: number[]; jobs: Array<{ name: string }> };
    }>("select details from normalized_events where event_id = $1", ["github:day2-run"]);
    expect(stored.rows[0]?.details.status).toBe("completed");
    expect(stored.rows[0]?.details.conclusion).toBe("success");
    expect(stored.rows[0]?.details.attempt).toBe(2);
    expect(stored.rows[0]?.details.pullRequestNumbers).toEqual([8]);
    expect(stored.rows[0]?.details.jobs[0]?.name).toBe("test");
  });

  function event(input: { eventId: string; createdAt: string; text: string | null }) {
    return normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: input.eventId,
      sourceKey: input.eventId,
      projectId,
      source: "codex",
      occurredAt: input.createdAt,
      details: {
        kind: "session.started",
        sessionId: input.eventId.split(":")[1],
        createdAt: input.createdAt,
        sourceVersion: "0.130.0",
      },
    });
  }

  function postEvents(token: string, events: unknown[]) {
    return fetch(`${baseUrl}/ingest/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, events }),
    });
  }
});

describe("dummy repository enrichment", () => {
  it("reads the current pull request and workflow run from the test repository", () => {
    const repo = "bryanlaiwei/automatic-project-map-test";
    const pulls = githubJson(`/repos/${repo}/pulls?state=all&per_page=5`);
    expect(Array.isArray(pulls)).toBe(true);
    const pull = (pulls as Array<{ number: number; html_url: string }>).find((item) => item.number > 0);
    expect(pull).toBeTruthy();
    const number = pull?.number ?? 0;
    const full = githubJson(`/repos/${repo}/pulls/${number}`);
    const commits = githubJson(`/repos/${repo}/pulls/${number}/commits`);
    const files = githubJson(`/repos/${repo}/pulls/${number}/files`);
    const snapshot = snapshotFromPullRequest(full, commits, files);
    expect(snapshot).not.toBeNull();
    const stale = normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: "github:dummy",
      sourceKey: "github:dummy",
      projectId: "22222222-2222-4222-8222-222222222222",
      source: "github",
      occurredAt: "2026-09-24T12:00:00.000Z",
      details: {
        kind: "pr.updated",
        repositoryId: 1386548319,
        pullRequestId: 1,
        number,
        title: "stale",
        body: "",
        url: "https://github.com/bryanlaiwei/automatic-project-map-test/pull/1",
        draft: true,
        state: "open",
        merged: false,
        headSha: "unknown",
        updatedAt: "2026-09-24T12:00:00.000Z",
      },
    });
    const enriched = applyPullRequestSnapshot(stale, snapshot!);
    expect(enriched.details.kind === "pr.updated" && enriched.details.title).toBe(
      typeof (full as { title?: unknown }).title === "string" ? (full as { title: string }).title : "",
    );
    expect(enriched.details.kind === "pr.updated" && enriched.details.headSha).not.toBe("unknown");
    expect(enriched.details.kind === "pr.updated" && (enriched.details.commits?.length ?? 0)).toBeGreaterThan(0);

    const runs = githubJson(`/repos/${repo}/actions/runs?per_page=5`) as { workflow_runs?: Array<{ id: number }> };
    const runId = runs.workflow_runs?.[0]?.id;
    expect(runId).toBeTruthy();
    const run = githubJson(`/repos/${repo}/actions/runs/${runId}`);
    const jobs = githubJson(`/repos/${repo}/actions/runs/${runId}/jobs`);
    const workflow = snapshotFromWorkflow(run, jobs);
    expect(workflow?.headSha.length).toBeGreaterThan(0);
    expect(workflow?.jobs.length).toBeGreaterThan(0);
    const kept = preserveKnownMerge(
      { ...snapshot!, merged: false, state: "open", updatedAt: "2020-01-01T00:00:00.000Z" },
      { merged: true, updatedAt: "2026-09-24T19:00:00.000Z" },
    );
    expect(kept.merged).toBe(true);
  });
});

function githubJson(path: string): unknown {
  const response = execFileSync(
    "gh",
    ["api", path.startsWith("/") ? path.slice(1) : path, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"],
    { encoding: "utf8" },
  );
  return JSON.parse(response) as unknown;
}
