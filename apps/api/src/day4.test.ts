import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthUser } from "./auth.js";
import { getPool } from "./db.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const pool = getPool();
const people: Record<string, AuthUser> = {
  owner: { id: "d4000000-0000-4000-8000-000000000001", githubLogin: "day4-owner", name: "Day Four", avatarUrl: null },
  mate: { id: "d4000000-0000-4000-8000-000000000002", githubLogin: "Day4-Mate", name: null, avatarUrl: null },
  stranger: { id: "d4000000-0000-4000-8000-000000000003", githubLogin: "day4-stranger", name: null, avatarUrl: null },
};
const repoId = 88_005_001;

describe("Day 4 membership, settings and layout", () => {
  let server: Server;
  let baseUrl = "";
  let projectId = "";

  beforeAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["day4/team"]);
    await pool.query("delete from profiles where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    server = createApp({
      pool,
      webhookSecret: "unused",
      verifyUser: async (token) => people[token] ?? null,
      verifyRepositoryAccess: async (input) => (input.owner === "day4" && input.name === "team" ? { status: "accessible", repoId } : { status: "denied" }),
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await pool.query("delete from workspaces where name = $1", ["day4/team"]);
    await pool.query("delete from profiles where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function call(who: keyof typeof people | string, path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${who}`, "Content-Type": "application/json", ...init.headers },
    });
  }

  it("connects a repository from owner/name alone", async () => {
    const connected = await call("owner", "/projects", { method: "POST", body: JSON.stringify({ owner: "day4", name: "team" }) });
    expect(connected.status).toBe(201);
    const body = (await connected.json()) as { project: { id: string; repoId: number } };
    expect(body.project.repoId).toBe(repoId);
    projectId = body.project.id;
    const listed = (await (await call("owner", "/projects")).json()) as { projects: Array<{ id: string; role: string }> };
    expect(listed.projects).toEqual([expect.objectContaining({ id: projectId, role: "owner" })]);
  });

  it("lets only the invited GitHub account join, and members see the same map", async () => {
    expect((await call("owner", "/me")).status).toBe(200);
    expect((await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "not a login!" }) })).status).toBe(400);
    const invited = await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "@day4-mate" }) });
    expect(invited.status).toBe(201);
    const invitationId = ((await invited.json()) as { id: string }).id;
    expect((await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "DAY4-MATE" }) })).status).toBe(409);

    const strangerView = (await (await call("stranger", "/me")).json()) as { invitations: unknown[] };
    expect(strangerView.invitations).toEqual([]);
    expect((await call("stranger", `/invitations/${invitationId}/accept`, { method: "POST" })).status).toBe(403);
    expect((await call("stranger", `/projects/${projectId}/graph`)).status).toBe(404);

    const mateView = (await (await call("mate", "/me")).json()) as { invitations: Array<{ id: string; project: { owner: string; name: string }; invitedBy: string }> };
    expect(mateView.invitations).toEqual([
      expect.objectContaining({ id: invitationId, project: expect.objectContaining({ owner: "day4", name: "team" }), invitedBy: "day4-owner" }),
    ]);
    expect((await call("mate", `/invitations/${invitationId}/accept`, { method: "POST" })).status).toBe(201);
    expect((await call("mate", `/invitations/${invitationId}/accept`, { method: "POST" })).status).toBe(404);
    const mateProjects = (await (await call("mate", "/projects")).json()) as { projects: Array<{ id: string; role: string }> };
    expect(mateProjects.projects).toEqual([expect.objectContaining({ id: projectId, role: "member" })]);

    const ownerGraph = await (await call("owner", `/projects/${projectId}/graph`)).json();
    const mateGraph = await (await call("mate", `/projects/${projectId}/graph`)).json();
    expect(mateGraph).toEqual(ownerGraph);

    expect((await call("mate", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "someone" }) })).status).toBe(403);
    expect((await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "day4-mate" }) })).status).toBe(409);

    const settings = (await (await call("owner", `/projects/${projectId}/settings`)).json()) as {
      role: string;
      members: Array<{ githubLogin: string; role: string; you: boolean }>;
      invitations: unknown[];
      health: { analysis: { waiting: number } };
    };
    expect(settings.role).toBe("owner");
    expect(settings.members.map((member) => [member.githubLogin, member.role, member.you])).toEqual([
      ["day4-owner", "owner", true],
      ["Day4-Mate", "member", false],
    ]);
    expect(settings.invitations).toEqual([]);
    expect(settings.health.analysis.waiting).toBe(0);
  });

  it("revokes an open invitation", async () => {
    const invited = await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "day4-stranger" }) });
    const invitationId = ((await invited.json()) as { id: string }).id;
    expect((await call("owner", `/projects/${projectId}/invitations/${invitationId}`, { method: "DELETE" })).status).toBe(204);
    expect((await call("stranger", `/invitations/${invitationId}/accept`, { method: "POST" })).status).toBe(404);
  });

  it("stops a removed member's web access and the helper they paired", async () => {
    const code = (await (await call("mate", `/projects/${projectId}/collector/pairing-codes`, { method: "POST" })).json()) as { code: string };
    const paired = (await (await fetch(`${baseUrl}/collector/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.code, label: "mate laptop" }),
    })).json()) as { token: string; deviceId: string };
    const upload = () => call(paired.token, "/ingest/events", { method: "POST", body: JSON.stringify({ projectId, events: [] }) });
    expect((await upload()).status).toBe(202);

    const settings = (await (await call("owner", `/projects/${projectId}/settings`)).json()) as {
      devices: Array<{ id: string; label: string; pairedBy: string; lastSeenAt: string | null }>;
    };
    expect(settings.devices).toEqual([expect.objectContaining({ id: paired.deviceId, label: "mate laptop", pairedBy: "Day4-Mate" })]);
    expect(settings.devices[0]?.lastSeenAt).not.toBeNull();

    expect((await call("mate", `/projects/${projectId}/members/${people.owner?.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await call("owner", `/projects/${projectId}/members/${people.owner?.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await call("owner", `/projects/${projectId}/members/${people.mate?.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call("mate", `/projects/${projectId}/graph`)).status).toBe(404);
    expect((await upload()).status).toBe(401);
  });

  it("saves node positions for this project's features without changing the graph revision", async () => {
    const feature = await pool.query<{ id: string }>(
      `insert into feature_groups (project_id, title, title_basis, summary, summary_basis)
       values ($1, 'Layout test', 'inferred', '', 'inferred') returning id`,
      [projectId],
    );
    const featureId = feature.rows[0]?.id ?? "";
    const before = (await (await call("owner", `/projects/${projectId}/graph/revision`)).json()) as { revision: number };
    const saved = await call("owner", `/projects/${projectId}/layout`, {
      method: "PUT",
      body: JSON.stringify({
        positions: [
          { nodeId: featureId, x: 120.5, y: -40 },
          { nodeId: "00000000-0000-4000-8000-000000000999", x: 0, y: 0 },
        ],
      }),
    });
    expect(await saved.json()).toEqual({ saved: 1 });
    const layout = (await (await call("owner", `/projects/${projectId}/layout`)).json()) as { positions: unknown[] };
    expect(layout.positions).toEqual([{ nodeId: featureId, x: 120.5, y: -40 }]);
    const after = (await (await call("owner", `/projects/${projectId}/graph/revision`)).json()) as { revision: number };
    expect(after.revision).toBe(before.revision);
    expect((await call("stranger", `/projects/${projectId}/layout`, { method: "PUT", body: JSON.stringify({ positions: [] }) })).status).toBe(404);
    expect((await call("owner", `/projects/${projectId}/layout`, { method: "PUT", body: JSON.stringify({ positions: [{ nodeId: featureId, x: "left", y: 0 }] }) })).status).toBe(400);
  });

  it("lets only an owner delete the project, which removes its data", async () => {
    const invited = await call("owner", `/projects/${projectId}/invitations`, { method: "POST", body: JSON.stringify({ githubLogin: "day4-mate" }) });
    const invitationId = ((await invited.json()) as { id: string }).id;
    expect((await call("mate", `/invitations/${invitationId}/accept`, { method: "POST" })).status).toBe(201);
    expect((await call("mate", `/projects/${projectId}`, { method: "DELETE" })).status).toBe(403);

    expect((await call("owner", `/projects/${projectId}`, { method: "DELETE" })).status).toBe(204);
    expect((await call("owner", `/projects/${projectId}/graph`)).status).toBe(404);
    const left = await pool.query(`select 1 from feature_groups where project_id = $1`, [projectId]);
    expect(left.rowCount).toBe(0);
    expect((await (await call("owner", "/projects")).json()) as unknown).toEqual({ projects: [] });
  });
});
