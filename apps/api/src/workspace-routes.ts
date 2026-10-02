import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { GithubAccountLookup } from "@apm/github-collector/access";
import type { AuthUser } from "@apm/core/auth-user";
import { config } from "@apm/core/config";
import { deleteModelCredential, readModelCredential, readStoredModelKey, resolvedModel, saveModelCredential } from "@apm/core/model-credentials";
import {
  checkModelKey,
  isModelProviderId,
  listSupplierModels,
  modelIdPattern,
  modelProviders,
  type ListSupplierModels,
  type ModelKeyCheck,
} from "@apm/core/model-providers";
import { modelSecretsConfigured, ModelSecretsError } from "@apm/core/secret-box";
import {
  acceptInvitation,
  deleteProject,
  githubLoginPattern,
  inviteMember,
  listPendingInvitations,
  projectRepository,
  readLayout,
  readSettings,
  removeMember,
  revokeDevice,
  revokeInvitation,
  saveLayout,
  saveProfile,
  type Role,
} from "@apm/core/workspace";
import { meSchema, modelSetupSchema } from "@apm/shared";
import { accessFrom, requireAccess } from "./require-access.js";

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
const saveModelBody = z.object({
  provider: z.string(),
  apiKey: z.string(),
  model: z.string(),
});
const listModelsBody = z.object({
  provider: z.string(),
  apiKey: z.string(),
});

export function workspaceRouter(input: {
  pool: Pool;
  authenticate: (req: Request, res: Response) => Promise<AuthUser | null>;
  member: MemberAccess;
  lookupGithubAccount?: GithubAccountLookup | undefined;
  checkModelKey?: ModelKeyCheck | undefined;
  listSupplierModels?: ListSupplierModels | undefined;
}): Router {
  const router = Router();
  const { pool, authenticate, member, lookupGithubAccount } = input;
  const verifyModelKey = input.checkModelKey ?? checkModelKey;
  const listModels = input.listSupplierModels ?? listSupplierModels;
  const asMember = requireAccess(member);
  const asOwner = requireAccess(member, "owner");

  router.get("/me", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    await saveProfile(pool, user);
    res.json(
      meSchema.parse({
        user: { id: user.id, githubLogin: user.githubLogin ?? null, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null },
        invitations: await listPendingInvitations(pool, user),
      }),
    );
  });

  router.get("/me/model", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    res.json(
      modelSetupSchema.parse({
        credential: await readModelCredential(pool, user.id),
        serverFallback: Boolean(config().openAiApiKey),
        providers: modelProviders.map((provider) => ({
          id: provider.id,
          label: provider.label,
          defaultModel: provider.defaultModel,
          keyHint: provider.keyHint,
        })),
      }),
    );
  });

  router.put("/me/model", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    const parsed = saveModelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose OpenAI, Anthropic, or Gemini, and paste an API key." });
      return;
    }
    if (!isModelProviderId(parsed.data.provider)) {
      res.status(400).json({ error: "Choose OpenAI, Anthropic, or Gemini." });
      return;
    }
    const apiKey = parsed.data.apiKey.trim();
    if (/\s/.test(apiKey)) {
      res.status(400).json({ error: "The key contains a space. Paste the key by itself." });
      return;
    }
    if (apiKey.length < 12 || apiKey.length > 400) {
      res.status(400).json({ error: "Paste the supplier's API key." });
      return;
    }
    const model = resolvedModel(parsed.data.provider, parsed.data.model);
    if (!modelIdPattern.test(model)) {
      res.status(400).json({ error: "Enter a model id such as gpt-5-nano, or leave it blank to use the default." });
      return;
    }
    if (!modelSecretsConfigured()) {
      res.status(503).json({ error: "Set APM_SECRETS_KEY on the API before saving a model key. It encrypts keys at rest." });
      return;
    }
    const checked = await verifyModelKey({ provider: parsed.data.provider, apiKey, model });
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    try {
      res.json(await saveModelCredential(pool, user.id, { provider: parsed.data.provider, apiKey, model }));
    } catch (error) {
      if (error instanceof ModelSecretsError) {
        res.status(503).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post("/me/model/models", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    const parsed = listModelsBody.safeParse(req.body);
    if (!parsed.success || !isModelProviderId(parsed.data.provider)) {
      res.status(400).json({ error: "Choose OpenAI, Anthropic, or Gemini." });
      return;
    }
    let apiKey = parsed.data.apiKey.trim();
    if (apiKey && (/\s/.test(apiKey) || apiKey.length < 12 || apiKey.length > 400)) {
      res.status(400).json({ error: "Paste the supplier's API key." });
      return;
    }
    if (!apiKey) {
      try {
        const stored = await readStoredModelKey(pool, user.id);
        if (!stored || stored.provider !== parsed.data.provider) {
          res.status(400).json({ error: "Paste an API key to load this supplier's models." });
          return;
        }
        apiKey = stored.apiKey;
      } catch (error) {
        if (error instanceof ModelSecretsError) {
          res.status(503).json({ error: error.message });
          return;
        }
        throw error;
      }
    }
    const listed = await listModels({ provider: parsed.data.provider, apiKey });
    if (!listed.ok) {
      res.status(400).json({ error: listed.error });
      return;
    }
    res.json({ models: listed.models });
  });

  router.delete("/me/model", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) {
      return;
    }
    await deleteModelCredential(pool, user.id);
    res.status(204).end();
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

  router.get("/projects/:projectId/settings", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    res.json(await readSettings(pool, { projectId: allowed.projectId, userId: allowed.user.id, role: allowed.role }));
  });

  router.post("/projects/:projectId/invitations", asOwner, async (req, res) => {
    const allowed = accessFrom(res);
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a GitHub username." });
      return;
    }
    const repository = await projectRepository(pool, allowed.projectId);
    if (!lookupGithubAccount || !repository) {
      res.status(503).json({ error: "Inviting needs the GitHub App to look up the account. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY." });
      return;
    }
    const account = await lookupGithubAccount({ ...repository, login: parsed.data.githubLogin });
    switch (account.status) {
      case "found":
        break;
      case "not_found":
        res.status(400).json({ error: `There is no GitHub user named @${parsed.data.githubLogin}.` });
        return;
      case "unavailable":
        res.status(503).json({ error: account.message });
        return;
      default: {
        const unhandled: never = account;
        throw new Error(`Unhandled account lookup ${JSON.stringify(unhandled)}`);
      }
    }
    const result = await inviteMember(pool, {
      projectId: allowed.projectId,
      invitedBy: allowed.user.id,
      githubLogin: account.login,
      githubUserId: account.id,
    });
    switch (result.status) {
      case "invited":
        res.status(201).json({ id: result.id });
        return;
      case "already_member":
        res.status(409).json({ error: `@${account.login} is already a member.` });
        return;
      case "already_invited":
        res.status(409).json({ error: `@${account.login} already has an open invitation.` });
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled invite result ${JSON.stringify(unhandled)}`);
      }
    }
  });

  router.delete("/projects/:projectId/invitations/:invitationId", asOwner, async (req, res) => {
    const allowed = accessFrom(res);
    const id = uuid.safeParse(req.params.invitationId);
    const revoked = id.success && (await revokeInvitation(pool, { projectId: allowed.projectId, invitationId: id.data }));
    res.status(revoked ? 204 : 404).end();
  });

  router.delete("/projects/:projectId/members/:userId", asMember, async (req, res) => {
    const allowed = accessFrom(res);
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

  router.delete("/projects/:projectId/devices/:deviceId", asMember, async (req, res) => {
    const allowed = accessFrom(res);
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

  router.delete("/projects/:projectId", asOwner, async (req, res) => {
    const allowed = accessFrom(res);
    await deleteProject(pool, allowed.projectId);
    res.status(204).end();
  });

  router.get("/projects/:projectId/layout", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    res.json({ positions: await readLayout(pool, allowed.projectId) });
  });

  router.put("/projects/:projectId/layout", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    const parsed = layoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Layout positions are invalid." });
      return;
    }
    res.json({ saved: await saveLayout(pool, allowed.projectId, parsed.data.positions) });
  });

  return router;
}
