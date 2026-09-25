import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const { createApp } = await import("./app.js");
const { getPool } = await import("./db.js");

const userId = "44444444-4444-4444-8444-444444444444";
const secret = "test-webhook-secret";
const repoId = 88000024;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("day 1 intake", () => {
  const pool = getPool();
  let baseUrl = "";
  let projectId = "";
  const server = createApp({
    pool,
    webhookSecret: secret,
    verifyUser: async (token) => (token === "test-user" ? { id: userId } : null),
  }).listen(0, "127.0.0.1");

  beforeAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["acme/day1"]);
    await pool.query("delete from webhook_deliveries where delivery_id = $1", ["delivery-day1-pr"]);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const connected = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "acme", name: "day1", repoId }),
    });
    expect(connected.status).toBe(201);
    const body = (await connected.json()) as { project: { id: string; trackingStartedAt: string } };
    projectId = body.project.id;
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["acme/day1"]);
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
    const listed = await fetch(`${baseUrl}/projects/${projectId}/events`, {
      headers: { Authorization: "Bearer test-user" },
    });
    const events = (await listed.json()) as { events: Array<{ source: string; details: { kind: string } }> };
    expect(events.events.filter((event) => event.source === "github")).toHaveLength(1);
  });

  it("stores an eligible local session and skips an old one", async () => {
    const response = await fetch(`${baseUrl}/ingest/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessions: [
          {
            source: "codex",
            sessionId: "new-session",
            createdAt: "2999-01-01T00:00:00.000Z",
            workingFolder: "/Projects/my-app",
            selectedRoots: ["/Projects/my-app"],
            sourceVersion: "0.130.0",
            records: [
              {
                id: "1",
                role: "user",
                text: "Add the check",
                occurredAt: "2999-01-01T00:00:01.000Z",
              },
            ],
          },
          {
            source: "claude_code",
            sessionId: "old-session",
            createdAt: "2000-01-01T00:00:00.000Z",
            workingFolder: "/Projects/my-app",
            selectedRoots: ["/Projects/my-app"],
            sourceVersion: "2.1.227",
            records: [],
          },
        ],
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { results: Array<{ sessionId: string; stored: boolean }> };
    expect(body.results).toEqual([
      { sessionId: "new-session", stored: true, reason: null },
      { sessionId: "old-session", stored: false, reason: "created_before_tracking" },
    ]);
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
});
