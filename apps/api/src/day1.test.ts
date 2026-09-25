import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  serializeIngestedSession,
  sha256Hex,
  splitSessionBytes,
  type IngestedSession,
} from "@apm/shared";
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

type UploadAck = {
  acknowledged: number[];
  complete: boolean;
  stored: boolean | null;
  reason: string | null;
  eventsStored: number | null;
};

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

function session(input: {
  sessionId: string;
  createdAt: string;
  records: Array<{ id: string; text: string }>;
  source?: IngestedSession["source"];
}): IngestedSession {
  return {
    source: input.source ?? "codex",
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    workingFolder: "/Projects/secret-folder",
    selectedRoots: ["/Projects/secret-folder"],
    sourceVersion: "0.130.0",
    records: input.records.map((record) => ({
      id: record.id,
      role: "user" as const,
      text: record.text,
      occurredAt: "2999-01-01T00:00:01.000Z",
    })),
  };
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

  async function bindServer(): Promise<void> {
    server = createApp(deps).listen(0, "127.0.0.1");
    await waitUntilListening(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
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

  it("stores an eligible local session and skips an old one", async () => {
    const fresh = session({
      sessionId: "new-session",
      createdAt: "2999-01-01T00:00:00.000Z",
      records: [{ id: "1", text: "Add the check" }],
    });
    const old = session({
      sessionId: "old-session",
      createdAt: "2000-01-01T00:00:00.000Z",
      records: [],
      source: "claude_code",
    });
    const stored = await uploadAll(fresh);
    const skipped = await uploadAll(old);
    expect(stored.acks.at(-1)).toMatchObject({ complete: true, stored: true, reason: null });
    expect(skipped.acks.at(-1)).toMatchObject({
      complete: true,
      stored: false,
      reason: "created_before_tracking",
    });
    const events = await listProjectEvents();
    expect(messagesFor(events, "new-session").map((message) => message.text)).toEqual(["Add the check"]);
    expect(events.some((event) => event.details.sessionId === "old-session")).toBe(false);
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

  it("ingests a multi-megabyte session from durable chunks and keeps the original records", async () => {
    const huge = session({
      sessionId: "big-session",
      createdAt: "2999-02-01T00:00:00.000Z",
      records: [
        { id: "note", text: 'café "quotes"\nline' },
        { id: "blob", text: "a".repeat(3 * 1024 * 1024) },
      ],
    });
    const serialized = serializeIngestedSession(huge);
    const pieces = splitSessionBytes(serialized);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(3 * 1024 * 1024);
    const contentSha256 = sha256Hex(Buffer.concat(pieces));

    const first = await postChunk(huge, pieces, contentSha256, 0);
    expect(first.status).toBe(200);
    expect(first.ack.complete).toBe(false);
    const again = await postChunk(huge, pieces, contentSha256, 0);
    expect(again.status).toBe(200);
    const staged = await pool.query<{ chunk_index: number; payload: Buffer }>(
      `select chunk_index, payload
       from session_upload_chunks
       where project_id = $1 and session_id = $2
       order by chunk_index`,
      [projectIdHolder.id, huge.sessionId],
    );
    expect(staged.rows).toHaveLength(1);
    expect(staged.rows[0]?.payload.equals(pieces[0] ?? Buffer.alloc(0))).toBe(true);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await bindServer();

    const status = await fetch(
      `${baseUrl}/ingest/sessions/chunks?projectId=${projectIdHolder.id}&source=${huge.source}&sessionId=${huge.sessionId}&contentSha256=${contentSha256}`,
      { headers: { Authorization: "Bearer test-user" } },
    );
    const statusBody = (await status.json()) as UploadAck;
    expect(statusBody.acknowledged).toEqual([0]);
    expect(statusBody.complete).toBe(false);

    for (let index = 1; index < pieces.length; index += 1) {
      const posted = await postChunk(huge, pieces, contentSha256, index);
      expect(posted.status).toBe(index === pieces.length - 1 ? 202 : 200);
    }

    const events = await listProjectEvents();
    expect(messagesFor(events, huge.sessionId)).toEqual(huge.records);
    expect(JSON.stringify(events)).not.toContain("/Projects/secret-folder");
    const remaining = await pool.query(`select 1 from session_upload_chunks where session_id = $1`, [huge.sessionId]);
    expect(remaining.rowCount).toBe(0);

    const retry = await postChunk(huge, pieces, contentSha256, 0);
    expect(retry.status).toBe(202);
    expect(retry.ack.complete).toBe(true);
    const afterRetry = await listProjectEvents();
    expect(afterRetry.filter((event) => event.details.sessionId === huge.sessionId)).toHaveLength(
      events.filter((event) => event.details.sessionId === huge.sessionId).length,
    );
  }, 30_000);

  it("stores a later upload of the same session and ignores an identical retry", async () => {
    const first = session({
      sessionId: "growing-session",
      createdAt: "2999-03-01T00:00:00.000Z",
      records: [{ id: "1", text: "first note" }],
    });
    const second = session({
      sessionId: "growing-session",
      createdAt: "2999-03-01T00:00:00.000Z",
      records: [
        { id: "1", text: "first note" },
        { id: "2", text: "second note" },
      ],
    });
    await uploadAll(first);
    await uploadAll(second);
    const events = await listProjectEvents();
    const content = events.filter(
      (event) => event.details.kind === "session.content_added" && event.details.sessionId === "growing-session",
    );
    expect(content).toHaveLength(2);
    expect(messagesFor(events, "growing-session").map((message) => message.text)).toContain("second note");
    const latest = content.find((event) => event.details.messages?.length === 2);
    expect(latest?.details.messages).toEqual(second.records);

    await uploadAll(second);
    const after = await listProjectEvents();
    expect(
      after.filter((event) => event.details.kind === "session.content_added" && event.details.sessionId === "growing-session"),
    ).toHaveLength(2);
  });

  it("keeps a partial upload resumable and rejects a conflicting chunk until reset", async () => {
    const original = session({
      sessionId: "paused-session",
      createdAt: "2999-04-01T00:00:00.000Z",
      records: [{ id: "1", text: "a".repeat(80) }],
    });
    const replacement = session({
      sessionId: "paused-session",
      createdAt: "2999-04-01T00:00:00.000Z",
      records: [{ id: "1", text: "b".repeat(80) }],
    });
    const serialized = serializeIngestedSession(original);
    const pieces = splitSessionBytes(serialized, 40);
    expect(pieces.length).toBeGreaterThan(1);
    const contentSha256 = sha256Hex(Buffer.concat(pieces));
    expect((await postChunk(original, pieces, contentSha256, 0)).status).toBe(200);

    const otherSerialized = serializeIngestedSession(replacement);
    const otherPieces = splitSessionBytes(otherSerialized, 40);
    const otherHash = sha256Hex(Buffer.concat(otherPieces));
    const conflict = await postChunk(replacement, otherPieces, otherHash, 0);
    expect(conflict.status).toBe(409);
    const replaced = await postChunk(replacement, otherPieces, otherHash, 0, true);
    expect(replaced.status).toBe(200);
    expect(replaced.ack.complete).toBe(false);

    const reset = await fetch(
      `${baseUrl}/ingest/sessions/chunks?projectId=${projectIdHolder.id}&source=${original.source}&sessionId=${original.sessionId}`,
      { method: "DELETE", headers: { Authorization: "Bearer test-user" } },
    );
    expect(reset.status).toBe(204);
    const uploaded = await uploadAll(replacement, 40);
    expect(uploaded.acks.at(-1)?.stored).toBe(true);
    expect(messagesFor(await listProjectEvents(), "paused-session").map((message) => message.text)).toEqual([
      "b".repeat(80),
    ]);
  });

  it("hides public tables from a role that is not the database owner", async () => {
    const tables = [
      "workspaces",
      "memberships",
      "projects",
      "normalized_events",
      "webhook_deliveries",
      "session_upload_chunks",
      "session_upload_receipts",
    ];
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

  async function postChunk(
    value: IngestedSession,
    pieces: Buffer[],
    contentSha256: string,
    index: number,
    replace = false,
  ): Promise<{ status: number; ack: UploadAck }> {
    const piece = pieces[index];
    if (!piece) {
      throw new Error(`Missing test chunk ${index}`);
    }
    const response = await fetch(`${baseUrl}/ingest/sessions/chunks`, {
      method: "POST",
      headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectIdHolder.id,
        source: value.source,
        sessionId: value.sessionId,
        chunkIndex: index,
        chunkCount: pieces.length,
        contentSha256,
        payload: piece.toString("base64"),
        ...(replace ? { replace: true } : {}),
      }),
    });
    const ack = (await response.json()) as UploadAck;
    return { status: response.status, ack };
  }

  async function uploadAll(value: IngestedSession, chunkBytes?: number) {
    const serialized = serializeIngestedSession(value);
    const pieces = splitSessionBytes(serialized, chunkBytes);
    const contentSha256 = sha256Hex(Buffer.concat(pieces));
    const acks = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const posted = await postChunk(value, pieces, contentSha256, index);
      expect(posted.status).toBe(index === pieces.length - 1 ? 202 : 200);
      acks.push(posted.ack);
    }
    return { pieces, contentSha256, acks };
  }
});

function messagesFor(events: ListedEvent[], sessionId: string) {
  return events.flatMap((event) => {
    if (event.details.kind !== "session.content_added" || event.details.sessionId !== sessionId) {
      return [];
    }
    return event.details.messages ?? [];
  });
}
