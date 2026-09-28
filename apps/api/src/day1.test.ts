import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryAccess } from "./github-app.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { createApp } = await import("./app.js");
const { getPool } = await import("./db.js");

const userId = "44444444-4444-4444-8444-444444444444";
const otherUserId = "55555555-5555-4555-8555-555555555555";
const secret = "test-webhook-secret";
const repoId = 88000024;
const projectIdHolder = { id: "" };

type ListedEvent = {
  eventId: string;
  source: string;
  details: {
    kind: string;
    sessionId?: string;
    messages?: Array<{ id: string; role: string; text: string; occurredAt: string }>;
  };
};

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("day 1 intake", () => {
  const pool = getPool();
  let baseUrl = "";
  let access: RepositoryAccess = { status: "accessible" };
  const deps = {
    pool,
    webhookSecret: secret,
    verifyUser: async (token: string) => {
      if (token === "test-user") {
        return { id: userId };
      }
      if (token === "other-user") {
        return { id: otherUserId };
      }
      return null;
    },
    verifyRepositoryAccess: async () => access,
  };
  let server: Server = createApp(deps).listen(0, "127.0.0.1");

  function waitUntilListening(next: Server): Promise<void> {
    if (next.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      next.once("listening", () => resolve());
      next.once("error", reject);
    });
  }

  beforeAll(async () => {
    await waitUntilListening(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    await pool.query("delete from workspaces where name = $1", ["acme/day1"]);
    await pool.query(
      `delete from workspaces where id in (select workspace_id from memberships where user_id = $1)`,
      [otherUserId],
    );
    await pool.query("delete from webhook_deliveries where delivery_id = $1", ["delivery-day1-pr"]);
    const connected = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "acme", name: "day1", repoId }),
    });
    expect(connected.status).toBe(201);
    const body = (await connected.json()) as { project: { id: string } };
    projectIdHolder.id = body.project.id;
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["acme/day1"]);
    await pool.query(
      `delete from workspaces where id in (select workspace_id from memberships where user_id = $1)`,
      [otherUserId],
    );
    await pool.query("delete from webhook_deliveries where delivery_id = $1", ["delivery-day1-pr"]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  });

  it("stores a signed pull request webhook and ignores a second delivery", async () => {
    const payload = JSON.stringify({
      repository: { id: repoId },
      pull_request: {
        id: 51,
        number: 4,
        title: "Add validation",
        body: "",
        html_url: "https://github.com/acme/day1/pull/4",
        draft: false,
        state: "open",
        merged_at: null,
        updated_at: "2026-09-24T21:00:00.000Z",
        head: { sha: "abc123" },
      },
    });
    const headers = {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-day1-pr",
      "X-Hub-Signature-256": sign(payload),
    };
    const first = await fetch(`${baseUrl}/github/webhook`, { method: "POST", headers, body: payload });
    const second = await fetch(`${baseUrl}/github/webhook`, { method: "POST", headers, body: payload });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const events = await listProjectEvents();
    expect(events.filter((event) => event.source === "github")).toHaveLength(1);
  });

  it("rejects a webhook with a bad signature", async () => {
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "nope",
        "X-Hub-Signature-256": "sha256=00",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a second claim on a repository and a repo the App cannot access", async () => {
    try {
      const duplicate = await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { Authorization: "Bearer other-user", "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "acme", name: "day1", repoId }),
      });
      expect(duplicate.status).toBe(409);
      const duplicateBody = (await duplicate.json()) as { error: string };
      expect(duplicateBody.error).toMatch(/already connected/);
      const memberships = await pool.query(`select 1 from memberships where user_id = $1`, [otherUserId]);
      expect(memberships.rowCount).toBe(0);

      access = { status: "denied" };
      const denied = await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { Authorization: "Bearer other-user", "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "acme", name: "other", repoId: repoId + 1 }),
      });
      expect(denied.status).toBe(403);

      access = {
        status: "not_configured",
        message: "GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
      };
      const unconfigured = await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { Authorization: "Bearer other-user", "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "acme", name: "other", repoId: repoId + 2 }),
      });
      expect(unconfigured.status).toBe(503);
      const unconfiguredBody = (await unconfigured.json()) as { error: string };
      expect(unconfiguredBody.error).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    } finally {
      access = { status: "accessible" };
    }
  });

  it("hides public tables from a role that is not the database owner", async () => {
    const tables = ["workspaces", "memberships", "projects", "normalized_events", "webhook_deliveries"];
    const flags = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
      [tables],
    );
    expect(flags.rows).toHaveLength(tables.length);
    expect(flags.rows.every((row) => row.relrowsecurity)).toBe(true);
    const policies = await pool.query<{ count: number }>(
      `select count(*)::int as count from pg_policies where schemaname = 'public' and tablename = any($1::text[])`,
      [tables],
    );
    expect(policies.rows[0]?.count).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("create role rls_probe");
      await client.query("grant usage on schema public to rls_probe");
      await client.query(
        "grant select, insert, update, delete on all tables in schema public to rls_probe",
      );
      // Local Supabase connects as postgres, which is not a superuser. SET ROLE
      // is allowed only for roles this user belongs to.
      await client.query("grant rls_probe to current_user");
      await client.query("set local role rls_probe");
      const visible = await client.query<{ count: number }>("select count(*)::int as count from projects");
      expect(visible.rows[0]?.count).toBe(0);
      await expect(client.query("insert into workspaces (name) values ('blocked-by-rls')")).rejects.toThrow(
        /row-level security/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  async function listProjectEvents(): Promise<ListedEvent[]> {
    const listed = await fetch(`${baseUrl}/projects/${projectIdHolder.id}/events`, {
      headers: { Authorization: "Bearer test-user" },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { events: ListedEvent[] };
    return body.events;
  }
});
