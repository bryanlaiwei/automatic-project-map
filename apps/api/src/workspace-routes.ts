import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import {
  acceptInvitation,
  deleteProject,
  githubLoginPattern,
  inviteMember,
  listPendingInvitations,
  readLayout,
  readSettings,
  removeMember,
  revokeDevice,
  revokeInvitation,
  saveLayout,
  saveProfile,
  type Role,
} from "./workspace.js";

export type MemberAccess = (req: Request, res: Response) => Promise<{ user: AuthUser; projectId: string; role: Role } | null>;

const uuid = z.string().uuid();
const inviteBody = z.object({
  githubLogin: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    .pipe(z.string().regex(githubLoginPattern, "Enter a GitHub username.")),
});
const layoutBody = z.object({
  positions: z
    .array(z.object({ nodeId: uuid, x: z.number().finite(), y: z.number().finite() }))
    .max(500),
});

export function workspaceRouter(input: {
  pool: Pool;
  authenticate: (req: Request, res: Response) => Promise<AuthUser | null>;
  member: MemberAccess;
}): Router {
  const router = Router();
  const { pool, authenticate, member } = input;

  async function owner(req: Request, res: Response) {
    const allowed = await member(req, res);
    if (allowed && allowed.role !== "owner") {
      res.status(403).json({ error: "Only project owners can do that." });
      return null;
    }
    return allowed;
  }

  router.get("/me", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    await saveProfile(pool, user);
    res.json({
      user: { id: user.id, githubLogin: user.githubLogin ?? null, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null },
      invitations: await listPendingInvitations(pool, user.githubLogin),
    });
  });

  router.post("/invitations/:invitationId/accept", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    const id = uuid.safeParse(req.params.invitationId);
    const result = id.success ? await acceptInvitation(pool, { invitationId: id.data, user }) : { status: "not_found" as const };
    switch (result.status) {
      case "joined":
        await saveProfile(pool, user);
        res.status(201).json({ projectId: result.projectId });
        return;
      case "not_found":
        res.status(404).json({ error: "That invitation is no longer open." });
        return;
      case "wrong_account":
        res.status(403).json({ error: "That invitation is for a different GitHub account." });
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled invitation result ${JSON.stringify(unhandled)}`);
      }
    }
  });

  router.get("/projects/:projectId/settings", async (req, res) => {
    const allowed = await member(req, res);
    if (!allowed) {
      return;
    }
    res.json(await readSettings(pool, { projectId: allowed.projectId, userId: allowed.user.id, role: allowed.role }));
  });

  router.post("/projects/:projectId/invitations", async (req, res) => {
    const allowed = await owner(req, res);
    if (!allowed) {
      return;
    }
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a GitHub username." });
      return;
    }
    const result = await inviteMember(pool, { projectId: allowed.projectId, invitedBy: allowed.user.id, githubLogin: parsed.data.githubLogin });
    switch (result.status) {
      case "invited":
        res.status(201).json({ id: result.id });
        return;
      case "already_member":
        res.status(409).json({ error: `@${parsed.data.githubLogin} is already a member.` });
        return;
      case "already_invited":
        res.status(409).json({ error: `@${parsed.data.githubLogin} already has an open invitation.` });
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled invite result ${JSON.stringify(unhandled)}`);
      }
    }
  });

  router.delete("/projects/:projectId/invitations/:invitationId", async (req, res) => {
    const allowed = await owner(req, res);
    if (!allowed) {
      return;
    }
    const id = uuid.safeParse(req.params.invitationId);
    const revoked = id.success && (await revokeInvitation(pool, { projectId: allowed.projectId, invitationId: id.data }));
    res.status(revoked ? 204 : 404).end();
  });

  router.delete("/projects/:projectId/members/:userId", async (req, res) => {
    const allowed = await member(req, res);
    if (!allowed) {
      return;
    }
    const id = uuid.safeParse(req.params.userId);
    if (!id.success) {
      res.status(404).json({ error: "Member not found." });
      return;
    }
    if (allowed.role !== "owner" && id.data !== allowed.user.id) {
      res.status(403).json({ error: "Only project owners can remove other people." });
      return;
    }
    const result = await removeMember(pool, { projectId: allowed.projectId, userId: id.data });
    switch (result.status) {
      case "removed":
        res.status(204).end();
        return;
      case "not_found":
        res.status(404).json({ error: "Member not found." });
        return;
      case "last_owner":
        res.status(409).json({ error: "A project needs at least one owner. Delete the project instead." });
        return;
      default: {
        const unhandled: never = result.status;
        throw new Error(`Unhandled removal result ${String(unhandled)}`);
      }
    }
  });

  router.delete("/projects/:projectId/devices/:deviceId", async (req, res) => {
    const allowed = await member(req, res);
    if (!allowed) {
      return;
    }
    const id = uuid.safeParse(req.params.deviceId);
    const result = id.success
      ? await revokeDevice(pool, { projectId: allowed.projectId, deviceId: id.data, userId: allowed.user.id, role: allowed.role })
      : "not_found";
    switch (result) {
      case "revoked":
        res.status(204).end();
        return;
      case "not_found":
        res.status(404).json({ error: "Device not found." });
        return;
      case "forbidden":
        res.status(403).json({ error: "Only the person who paired this helper or a project owner can disconnect it." });
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled device result ${String(unhandled)}`);
      }
    }
  });

  router.delete("/projects/:projectId", async (req, res) => {
    const allowed = await owner(req, res);
    if (!allowed) {
      return;
    }
    await deleteProject(pool, allowed.projectId);
    res.status(204).end();
  });

  router.get("/projects/:projectId/layout", async (req, res) => {
    const allowed = await member(req, res);
    if (!allowed) {
      return;
    }
    res.json({ positions: await readLayout(pool, allowed.projectId) });
  });

  router.put("/projects/:projectId/layout", async (req, res) => {
    const allowed = await member(req, res);
    if (!allowed) {
      return;
    }
    const parsed = layoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Layout positions are invalid." });
      return;
    }
    res.json({ saved: await saveLayout(pool, allowed.projectId, parsed.data.positions) });
  });

  return router;
}
