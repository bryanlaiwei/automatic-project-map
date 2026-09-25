import type { Pool } from "pg";
import type { AuthUser } from "./auth.js";
import { inTransaction } from "./graph/process.js";

export type Role = "owner" | "member";

export type Person = {
  userId: string;
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export type PendingInvitation = {
  id: string;
  project: { id: string; owner: string; name: string };
  invitedBy: string | null;
  createdAt: string;
};

export type ProjectSettings = {
  project: { id: string; owner: string; name: string; repoId: number; trackingStartedAt: string };
  role: Role;
  members: Array<Person & { role: Role; joinedAt: string; you: boolean }>;
  invitations: Array<{ id: string; githubLogin: string; invitedBy: string | null; createdAt: string }>;
  devices: Array<{ id: string; label: string; pairedBy: string | null; createdAt: string; lastSeenAt: string | null; yours: boolean }>;
  health: {
    github: { lastDeliveryAt: string | null; failedDeliveries: number; waitingDeliveries: number };
    local: { lastSessionEventAt: string | null };
    analysis: {
      waiting: number;
      waitingSince: string | null;
      gaveUp: number;
      lastAnalyzedAt: string | null;
      lastFailure: { at: string; error: string } | null;
    };
  };
};

export const githubLoginPattern = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Remembers how a signed-in person appears on GitHub. Skipped when the token carried no GitHub identity. */
export async function saveProfile(pool: Pool, user: AuthUser): Promise<void> {
  if (!user.githubLogin && !user.name && !user.avatarUrl) {
    return;
  }
  await pool.query(
    `insert into profiles (user_id, github_login, display_name, avatar_url, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id) do update
       set github_login = excluded.github_login,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           updated_at = now()`,
    [user.id, user.githubLogin ?? null, user.name ?? null, user.avatarUrl ?? null],
  );
}

export async function projectRole(pool: Pool, userId: string, projectId: string): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>(
    `select m.role from projects p
     join memberships m on m.workspace_id = p.workspace_id
     where p.id = $1 and m.user_id = $2`,
    [projectId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function listProjectRoles(pool: Pool, userId: string): Promise<Map<string, Role>> {
  const result = await pool.query<{ id: string; role: Role }>(
    `select p.id, m.role from projects p
     join memberships m on m.workspace_id = p.workspace_id
     where m.user_id = $1`,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.id, row.role]));
}

export async function listPendingInvitations(pool: Pool, githubLogin: string | null | undefined): Promise<PendingInvitation[]> {
  if (!githubLogin) {
    return [];
  }
  const result = await pool.query<{ id: string; project_id: string; github_owner: string; github_name: string; invited_by: string | null; created_at: Date }>(
    `select i.id, p.id as project_id, p.github_owner, p.github_name, pr.github_login as invited_by, i.created_at
     from invitations i
     join projects p on p.workspace_id = i.workspace_id
     left join profiles pr on pr.user_id = i.invited_by
     where lower(i.github_login) = lower($1) and i.accepted_at is null and i.revoked_at is null
     order by i.created_at`,
    [githubLogin],
  );
  return result.rows.map((row) => ({
    id: row.id,
    project: { id: row.project_id, owner: row.github_owner, name: row.github_name },
    invitedBy: row.invited_by,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function acceptInvitation(
  pool: Pool,
  input: { invitationId: string; user: AuthUser },
): Promise<{ status: "joined"; projectId: string } | { status: "not_found" | "wrong_account" }> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ workspace_id: string; github_login: string; role: Role; project_id: string }>(
      `select i.workspace_id, i.github_login, i.role, p.id as project_id
       from invitations i
       join projects p on p.workspace_id = i.workspace_id
       where i.id = $1 and i.accepted_at is null and i.revoked_at is null
       for update of i`,
      [input.invitationId],
    );
    const row = found.rows[0];
    if (!row) {
      return { status: "not_found" as const };
    }
    if (!input.user.githubLogin || input.user.githubLogin.toLowerCase() !== row.github_login.toLowerCase()) {
      return { status: "wrong_account" as const };
    }
    await client.query(
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do nothing`,
      [row.workspace_id, input.user.id, row.role],
    );
    await client.query(`update invitations set accepted_at = now(), accepted_by = $2 where id = $1`, [input.invitationId, input.user.id]);
    return { status: "joined" as const, projectId: row.project_id };
  });
}

export async function inviteMember(
  pool: Pool,
  input: { projectId: string; invitedBy: string; githubLogin: string },
): Promise<{ status: "invited"; id: string } | { status: "already_member" | "already_invited" }> {
  return inTransaction(pool, async (client) => {
    const project = await client.query<{ workspace_id: string }>(`select workspace_id from projects where id = $1 for update`, [input.projectId]);
    const workspaceId = project.rows[0]?.workspace_id;
    if (!workspaceId) {
      throw new Error("Project disappeared while inviting.");
    }
    const member = await client.query(
      `select 1 from memberships m join profiles p on p.user_id = m.user_id
       where m.workspace_id = $1 and lower(p.github_login) = lower($2)`,
      [workspaceId, input.githubLogin],
    );
    if ((member.rowCount ?? 0) > 0) {
      return { status: "already_member" as const };
    }
    const inserted = await client.query<{ id: string }>(
      `insert into invitations (workspace_id, github_login, invited_by) values ($1, $2, $3)
       on conflict do nothing
       returning id`,
      [workspaceId, input.githubLogin, input.invitedBy],
    );
    const id = inserted.rows[0]?.id;
    return id ? { status: "invited" as const, id } : { status: "already_invited" as const };
  });
}

export async function revokeInvitation(pool: Pool, input: { projectId: string; invitationId: string }): Promise<boolean> {
  const result = await pool.query(
    `update invitations i set revoked_at = now()
     from projects p
     where i.id = $2 and p.id = $1 and p.workspace_id = i.workspace_id and i.accepted_at is null and i.revoked_at is null`,
    [input.projectId, input.invitationId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Removes someone from the project and revokes the helpers they paired, so their uploads stop too. */
export async function removeMember(
  pool: Pool,
  input: { projectId: string; userId: string },
): Promise<{ status: "removed" | "not_found" | "last_owner" }> {
  return inTransaction(pool, async (client) => {
    const members = await client.query<{ user_id: string; role: Role; workspace_id: string }>(
      `select m.user_id, m.role, m.workspace_id from projects p
       join memberships m on m.workspace_id = p.workspace_id
       where p.id = $1
       for update of m`,
      [input.projectId],
    );
    const target = members.rows.find((row) => row.user_id === input.userId);
    if (!target) {
      return { status: "not_found" as const };
    }
    if (target.role === "owner" && members.rows.filter((row) => row.role === "owner").length === 1) {
      return { status: "last_owner" as const };
    }
    await client.query(`delete from memberships where workspace_id = $1 and user_id = $2`, [target.workspace_id, input.userId]);
    await client.query(
      `update collector_tokens set revoked_at = now() where project_id = $1 and user_id = $2 and revoked_at is null`,
      [input.projectId, input.userId],
    );
    return { status: "removed" as const };
  });
}

export async function revokeDevice(
  pool: Pool,
  input: { projectId: string; deviceId: string; userId: string; role: Role },
): Promise<"revoked" | "not_found" | "forbidden"> {
  const found = await pool.query<{ user_id: string | null }>(
    `select user_id from collector_tokens where id = $1 and project_id = $2 and revoked_at is null`,
    [input.deviceId, input.projectId],
  );
  const row = found.rows[0];
  if (!row) {
    return "not_found";
  }
  if (input.role !== "owner" && row.user_id !== input.userId) {
    return "forbidden";
  }
  await pool.query(`update collector_tokens set revoked_at = now() where id = $1`, [input.deviceId]);
  return "revoked";
}

/** A project is its workspace's only repository, so deleting it removes the workspace and everything stored for it. */
export async function deleteProject(pool: Pool, projectId: string): Promise<void> {
  await pool.query(`delete from workspaces where id = (select workspace_id from projects where id = $1)`, [projectId]);
}

export async function readSettings(pool: Pool, input: { projectId: string; userId: string; role: Role }): Promise<ProjectSettings | null> {
  const project = await pool.query<{ id: string; workspace_id: string; github_owner: string; github_name: string; github_repo_id: string; tracking_started_at: Date }>(
    `select id, workspace_id, github_owner, github_name, github_repo_id, tracking_started_at from projects where id = $1`,
    [input.projectId],
  );
  const row = project.rows[0];
  if (!row) {
    return null;
  }
  const members = await pool.query<{ user_id: string; role: Role; created_at: Date; github_login: string | null; display_name: string | null; avatar_url: string | null }>(
    `select m.user_id, m.role, m.created_at, p.github_login, p.display_name, p.avatar_url
     from memberships m
     left join profiles p on p.user_id = m.user_id
     where m.workspace_id = $1
     order by m.role = 'owner' desc, m.created_at`,
    [row.workspace_id],
  );
  const invitations = await pool.query<{ id: string; github_login: string; invited_by: string | null; created_at: Date }>(
    `select i.id, i.github_login, p.github_login as invited_by, i.created_at
     from invitations i
     left join profiles p on p.user_id = i.invited_by
     where i.workspace_id = $1 and i.accepted_at is null and i.revoked_at is null
     order by i.created_at`,
    [row.workspace_id],
  );
  const devices = await pool.query<{ id: string; label: string; user_id: string | null; github_login: string | null; created_at: Date; last_seen_at: Date | null }>(
    `select t.id, t.label, t.user_id, p.github_login, t.created_at, t.last_seen_at
     from collector_tokens t
     left join profiles p on p.user_id = t.user_id
     where t.project_id = $1 and t.revoked_at is null
     order by t.created_at`,
    [input.projectId],
  );
  const github = await pool.query<{ last_at: Date | null; failed: string; waiting: string }>(
    `select max(received_at) as last_at,
            count(*) filter (where status = 'failed') as failed,
            count(*) filter (where status = 'queued') as waiting
     from webhook_deliveries where github_repo_id = $1`,
    [row.github_repo_id],
  );
  const local = await pool.query<{ last_at: Date | null }>(
    `select max(received_at) as last_at from normalized_events where project_id = $1 and source <> 'github'`,
    [input.projectId],
  );
  const waiting = await pool.query<{ waiting: string; since: Date | null; gave_up: string }>(
    `select count(*) filter (where interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at is not null)) as waiting,
            min(created_at) filter (where interpretation_state = 'pending' or (interpretation_state = 'failed' and retry_at is not null)) as since,
            count(*) filter (where interpretation_state = 'failed' and retry_at is null) as gave_up
     from evidence where project_id = $1`,
    [input.projectId],
  );
  const batches = await pool.query<{ status: string; error: string | null; completed_at: Date }>(
    `select status, error, completed_at from processing_batches
     where project_id = $1 and stage = 'interpretation' and completed_at is not null
     order by completed_at desc
     limit 20`,
    [input.projectId],
  );
  const lastSuccess = batches.rows.find((batch) => batch.status === "applied" || batch.status === "no_change");
  const latest = batches.rows[0];
  const githubRow = github.rows[0];
  const waitingRow = waiting.rows[0];

  return {
    project: {
      id: row.id,
      owner: row.github_owner,
      name: row.github_name,
      repoId: Number(row.github_repo_id),
      trackingStartedAt: row.tracking_started_at.toISOString(),
    },
    role: input.role,
    members: members.rows.map((member) => ({
      userId: member.user_id,
      githubLogin: member.github_login,
      name: member.display_name,
      avatarUrl: member.avatar_url,
      role: member.role,
      joinedAt: member.created_at.toISOString(),
      you: member.user_id === input.userId,
    })),
    invitations: invitations.rows.map((invitation) => ({
      id: invitation.id,
      githubLogin: invitation.github_login,
      invitedBy: invitation.invited_by,
      createdAt: invitation.created_at.toISOString(),
    })),
    devices: devices.rows.map((device) => ({
      id: device.id,
      label: device.label,
      pairedBy: device.github_login,
      createdAt: device.created_at.toISOString(),
      lastSeenAt: device.last_seen_at?.toISOString() ?? null,
      yours: device.user_id === input.userId,
    })),
    health: {
      github: {
        lastDeliveryAt: githubRow?.last_at?.toISOString() ?? null,
        failedDeliveries: Number(githubRow?.failed ?? 0),
        waitingDeliveries: Number(githubRow?.waiting ?? 0),
      },
      local: { lastSessionEventAt: local.rows[0]?.last_at?.toISOString() ?? null },
      analysis: {
        waiting: Number(waitingRow?.waiting ?? 0),
        waitingSince: waitingRow?.since?.toISOString() ?? null,
        gaveUp: Number(waitingRow?.gave_up ?? 0),
        lastAnalyzedAt: lastSuccess?.completed_at.toISOString() ?? null,
        lastFailure:
          latest && latest.status === "failed" && latest.error && !latest.error.startsWith("superseded")
            ? { at: latest.completed_at.toISOString(), error: latest.error }
            : null,
      },
    },
  };
}

export type NodePosition = { nodeId: string; x: number; y: number };

export async function readLayout(pool: Pool, projectId: string): Promise<NodePosition[]> {
  const result = await pool.query<{ node_id: string; x: number; y: number }>(
    `select l.node_id, l.x, l.y from layout_positions l
     join feature_groups f on f.id = l.node_id and f.retired_into is null
     where l.project_id = $1`,
    [projectId],
  );
  return result.rows.map((row) => ({ nodeId: row.node_id, x: row.x, y: row.y }));
}

/** Saves positions for this project's features and ignores ids that are not one of them. */
export async function saveLayout(pool: Pool, projectId: string, positions: readonly NodePosition[]): Promise<number> {
  if (positions.length === 0) {
    return 0;
  }
  const result = await pool.query(
    `insert into layout_positions (project_id, node_id, x, y, updated_at)
     select $1, f.id, p.x, p.y, now()
     from unnest($2::uuid[], $3::float8[], $4::float8[]) as p(node_id, x, y)
     join feature_groups f on f.id = p.node_id and f.project_id = $1
     on conflict (project_id, node_id) do update set x = excluded.x, y = excluded.y, updated_at = now()`,
    [projectId, positions.map((position) => position.nodeId), positions.map((position) => position.x), positions.map((position) => position.y)],
  );
  return result.rowCount ?? 0;
}
