import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryAccess } from "./github-app.js";
import { snapshotFromPullRequest, snapshotFromWorkflow } from "./github-enrich.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { createApp } = await import("./app.js");
const { getPool } = await import("./db.js");
const { refreshObservedGithub } = await import("./github-refresh.js");
const { deliveryAttemptLimit, processQueuedDeliveries } = await import("./store.js");

const userId = "77777777-7777-4777-8777-777777777777";
const secret = "test-webhook-secret";
const repoId = 88000031;
const workspaceName = "acme/background";
const deliveryIds = ["bg-pr-opened", "bg-run-started", "bg-stale", "bg-fresh", "bg-broken", "bg-throws-inline"];

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pullRequest(input: { id: number; number: number; state: "open" | "closed"; merged: boolean; updatedAt: string }) {
  return {
    id: input.id,
    number: input.number,
    title: `Pull request ${input.number}`,
    body: "",
    html_url: `https://github.com/acme/background/pull/${input.number}`,
    draft: false,
    state: input.state,
    merged_at: input.merged ? input.updatedAt : null,
    updated_at: input.updatedAt,
    head: { sha: `head${input.number}` },
  };
}

describe("background GitHub work", () => {
  const pool = getPool();
  let baseUrl = "";
  let projectId = "";
  const pulls = new Map<number, unknown>();
  const runs = new Map<number, { run: unknown; jobs: unknown }>();
  const failing = new Set<number>();
  const github = {
    async enrichPullRequest(_owner: string, _name: string, number: number) {
      if (failing.has(number)) {
        throw new Error("fetch failed");
      }
      const body = pulls.get(number);
      return body ? snapshotFromPullRequest(body, [], []) : null;
    },
    async enrichWorkflowRun(_owner: string, _name: string, runId: number) {
      const body = runs.get(runId);
      return body ? snapshotFromWorkflow(body.run, body.jobs) : null;
    },
  };
  const server: Server = createApp({
    pool,
    webhookSecret: secret,
    verifyUser: async (token: string) => (token === "background-user" ? { id: userId } : null),
    verifyRepositoryAccess: async (): Promise<RepositoryAccess> => ({ status: "accessible" }),
    github,
  }).listen(0, "127.0.0.1");

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
    await pool.query("delete from workspaces where name = $1", [workspaceName]);
    await pool.query("delete from webhook_deliveries where delivery_id = any($1::text[])", [deliveryIds]);
    const connected = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { Authorization: "Bearer background-user", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "acme", name: "background", repoId }),
    });
    expect(connected.status).toBe(201);
    projectId = ((await connected.json()) as { project: { id: string } }).project.id;
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where name = $1", [workspaceName]);
    await pool.query("delete from webhook_deliveries where delivery_id = any($1::text[])", [deliveryIds]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function postWebhook(eventName: string, deliveryId: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": eventName,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": sign(body),
      },
      body,
    });
  }

  it("refresh stores a pull request merge that no webhook reported, once", async () => {
    const opened = pullRequest({ id: 3101, number: 11, state: "open", merged: false, updatedAt: "2026-09-25T10:00:00.000Z" });
    pulls.set(11, opened);
    expect((await postWebhook("pull_request", "bg-pr-opened", { repository: { id: repoId }, pull_request: opened })).status).toBe(202);

    pulls.set(11, pullRequest({ id: 3101, number: 11, state: "closed", merged: true, updatedAt: "2026-09-25T11:00:00.000Z" }));
    const first = await refreshObservedGithub(pool, github, { projectId });
    expect(first.eventsStored).toBeGreaterThanOrEqual(1);

    const stored = await pool.query<{ details: { merged: boolean; state: string } }>(
      "select details from normalized_events where event_id = $1",
      ["github:refresh:pull_request:3101:2026-09-25T11:00:00.000Z"],
    );
    expect(stored.rows[0]?.details).toMatchObject({ merged: true, state: "closed" });
    const observation = await pool.query<{ merged: boolean }>(
      "select merged from github_observations where project_id = $1 and kind = 'pull_request' and source_id = '3101'",
      [projectId],
    );
    expect(observation.rows[0]?.merged).toBe(true);

    const second = await refreshObservedGithub(pool, github, { projectId });
    const again = await pool.query(
      "select 1 from normalized_events where project_id = $1 and event_id like 'github:refresh:pull_request:3101:%'",
      [projectId],
    );
    expect(again.rowCount).toBe(1);
    expect(second.eventsStored).toBe(0);
  });

  it("refresh finishes a workflow run that was left running", async () => {
    const started = {
      id: 5101,
      status: "in_progress",
      conclusion: null,
      head_sha: "head11",
      run_attempt: 1,
      html_url: "https://github.com/acme/background/actions/runs/5101",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      pull_requests: [],
    };
    runs.set(5101, { run: started, jobs: { jobs: [] } });
    expect((await postWebhook("workflow_run", "bg-run-started", { repository: { id: repoId }, workflow_run: started })).status).toBe(202);

    const finishedAt = new Date().toISOString();
    runs.set(5101, {
      run: { ...started, status: "completed", conclusion: "failure", updated_at: finishedAt },
      jobs: { jobs: [{ id: 9, name: "test", status: "completed", conclusion: "failure", run_attempt: 1 }] },
    });
    await refreshObservedGithub(pool, github, { projectId });

    const stored = await pool.query<{ details: { status: string; conclusion: string; jobs: unknown[] } }>(
      "select details from normalized_events where event_id = $1",
      [`github:refresh:workflow_run:5101:1:${new Date(finishedAt).toISOString()}`],
    );
    expect(stored.rows[0]?.details).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(stored.rows[0]?.details.jobs).toHaveLength(1);
  });

  it("the sweep processes stale queued deliveries and one broken delivery does not block the rest", async () => {
    const insert = (deliveryId: string, number: number, age: string) =>
      pool.query(
        `insert into webhook_deliveries (delivery_id, event_name, github_repo_id, payload, status, received_at)
         values ($1, 'pull_request', $2, $3::jsonb, 'queued', now() - $4::interval)`,
        [
          deliveryId,
          repoId,
          JSON.stringify({
            repository: { id: repoId },
            pull_request: pullRequest({ id: 3200 + number, number, state: "open", merged: false, updatedAt: "2026-09-25T12:00:00.000Z" }),
          }),
          age,
        ],
      );
    failing.add(99);
    await insert("bg-broken", 99, "10 minutes");
    await insert("bg-stale", 21, "5 minutes");
    await insert("bg-fresh", 22, "0 seconds");

    await processQueuedDeliveries(pool, github, { olderThanSeconds: 60 });
    const statuses = async () =>
      Object.fromEntries(
        (
          await pool.query<{ delivery_id: string; status: string; attempts: number }>(
            "select delivery_id, status, attempts from webhook_deliveries where delivery_id = any($1::text[])",
            [["bg-broken", "bg-stale", "bg-fresh"]],
          )
        ).rows.map((row) => [row.delivery_id, `${row.status}:${row.attempts}`]),
      );
    expect(await statuses()).toEqual({ "bg-broken": "queued:1", "bg-stale": "processed:1", "bg-fresh": "queued:0" });

    for (let attempt = 1; attempt < deliveryAttemptLimit; attempt += 1) {
      await processQueuedDeliveries(pool, github, { olderThanSeconds: 60, deliveryIds: ["bg-broken"] });
    }
    expect((await statuses())["bg-broken"]).toBe(`failed:${deliveryAttemptLimit}`);
  });

  it("a webhook whose processing fails is still accepted and left for the sweep", async () => {
    failing.add(98);
    const response = await postWebhook("pull_request", "bg-throws-inline", {
      repository: { id: repoId },
      pull_request: pullRequest({ id: 3298, number: 98, state: "open", merged: false, updatedAt: "2026-09-25T12:30:00.000Z" }),
    });
    expect(response.status).toBe(202);
    const row = await pool.query<{ status: string; note: string }>(
      "select status, note from webhook_deliveries where delivery_id = 'bg-throws-inline'",
    );
    expect(row.rows[0]).toMatchObject({ status: "queued", note: "fetch failed" });

    failing.delete(98);
    await processQueuedDeliveries(pool, github, { deliveryIds: ["bg-throws-inline"] });
    const retried = await pool.query<{ status: string }>("select status from webhook_deliveries where delivery_id = 'bg-throws-inline'");
    expect(retried.rows[0]?.status).toBe("processed");
  });
});
