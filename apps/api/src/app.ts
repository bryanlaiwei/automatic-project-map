import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { JSON_BODY_LIMIT_BYTES, SCHEMA_VERSION } from "@apm/shared";
import type { AuthUser } from "./auth.js";
import type { GithubAccountLookup, RepositoryAccessCheck } from "@apm/github-collector/access";
import { verifyGithubSignature } from "@apm/github-collector/webhook";
import { createPairingCode, exchangePairingCode, findHelperDevice, revokeHelperToken } from "./helper-tokens.js";
import { graphRouter } from "./graph/routes.js";
import { workspaceRouter } from "./workspace-routes.js";
import { listProjectRoles, projectRole, type Role } from "./workspace.js";
import { ingestEvents } from "./ingest-events.js";
import type { ListSupplierModels, ModelKeyCheck } from "./model-providers.js";
import {
  connectRepository,
  enqueueDelivery,
  listEvents,
  listProjects,
  userCanAccessProject,
} from "./store.js";

const connectBody = z.object({
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  repoId: z.number().int().positive().optional(),
});

export type AppDeps = {
  pool: Pool;
  webhookSecret: string;
  verifyUser: (token: string) => Promise<AuthUser | null>;
  verifyRepositoryAccess: RepositoryAccessCheck;
  /**
   * Inserts one pg-boss job for a saved delivery. The worker calls GitHub; this request does not.
   * When this is omitted, the minute sweep still finishes the row.
   */
  enqueueDeliveryProcessing?: (deliveryId: string) => Promise<void>;
  lookupGithubAccount?: GithubAccountLookup;
  /** Checks a model key with the supplier. Tests pass a stub. */
  modelKeyCheck?: ModelKeyCheck;
  /** Lists models for a key. Tests pass a stub. */
  listSupplierModels?: ListSupplierModels;
};

const ingestBody = z.object({
  projectId: z.string().uuid(),
  events: z.array(z.unknown()).max(100),
});

const pairBody = z.object({
  code: z.string().min(1),
  label: z.string().max(80).optional(),
});

function bearerToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : "";
}

async function requireUser(deps: AppDeps, req: Request, res: Response): Promise<AuthUser | null> {
  const user = await deps.verifyUser(bearerToken(req));
  if (!user) {
    res.status(401).json({ error: "Sign in is required." });
    return null;
  }
  return user;
}

async function projectMember(
  deps: AppDeps,
  req: Request,
  res: Response,
): Promise<{ user: AuthUser; userId: string; projectId: string; role: Role } | null> {
  const user = await requireUser(deps, req, res);
  if (!user) {
    return null;
  }
  const projectId = req.params.projectId;
  const role = typeof projectId === "string" && uuidPattern.test(projectId) ? await projectRole(deps.pool, user.id, projectId) : null;
  if (typeof projectId !== "string" || !role) {
    res.status(404).json({ error: "Project not found." });
    return null;
  }
  return { user, userId: user.id, projectId, role };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(deps: AppDeps) {
  if (deps.webhookSecret.trim() === "") {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET is missing or empty. Refusing to start because an empty secret would accept forged webhooks.",
    );
  }

  const app = express();
  const allowedOrigins = new Set([
    process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);

  app.use((req, res, next) => {
    const requestOrigin = req.header("origin");
    if (requestOrigin && allowedOrigins.has(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, schemaVersion: SCHEMA_VERSION });
  });

  app.post("/github/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const valid = verifyGithubSignature(body, req.header("x-hub-signature-256"), deps.webhookSecret);
    if (!valid) {
      res.status(401).json({ error: "Invalid webhook signature." });
      return;
    }

    const eventName = req.header("x-github-event") ?? "";
    const deliveryId = req.header("x-github-delivery");
    if (!deliveryId) {
      res.status(400).json({ error: "Missing GitHub delivery id." });
      return;
    }

    let payload: unknown = {};
    if (body.length > 0) {
      try {
        payload = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        res.status(400).json({ error: "Webhook body is not JSON." });
        return;
      }
    }
    const repoId =
      typeof payload === "object" &&
      payload !== null &&
      "repository" in payload &&
      typeof payload.repository === "object" &&
      payload.repository !== null &&
      "id" in payload.repository &&
      typeof payload.repository.id === "number"
        ? payload.repository.id
        : null;

    const queued = await enqueueDelivery(deps.pool, {
      deliveryId,
      eventName,
      repoId,
      payload,
    });
    if (queued === "duplicate") {
      res.status(202).json({ accepted: true, duplicate: true });
      return;
    }

    // GitHub gives up after 10 seconds, and each enrichment call can take 15. The row is already saved,
    // so acknowledge before the worker calls GitHub. A failed handoff stays queued for the minute sweep.
    res.status(202).json({ accepted: true, duplicate: false });
    if (!deps.enqueueDeliveryProcessing) {
      return;
    }
    void deps.enqueueDeliveryProcessing(deliveryId).catch((error: unknown) => {
      console.error(
        `Webhook delivery ${deliveryId} was saved but not handed to the worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

  app.post("/projects", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const parsed = connectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter the repository as owner/name." });
      return;
    }
    const access = await deps.verifyRepositoryAccess({ ...parsed.data, login: user.githubLogin ?? null });
    switch (access.status) {
      case "accessible":
        break;
      case "denied":
        res.status(403).json({
          error: `The GitHub App is not installed on ${parsed.data.owner}/${parsed.data.name}. Install it on that repository, then connect again.`,
        });
        return;
      case "not_permitted":
        res.status(403).json({ error: access.message });
        return;
      case "not_configured":
      case "unavailable":
        res.status(503).json({ error: access.message });
        return;
      default: {
        const unexpected: never = access;
        throw new Error(`Unexpected repository access result: ${JSON.stringify(unexpected)}`);
      }
    }
    const repoId = parsed.data.repoId ?? (access.status === "accessible" ? access.repoId : undefined);
    if (repoId === undefined) {
      res.status(400).json({ error: "GitHub did not return an id for this repository." });
      return;
    }
    const result = await connectRepository(deps.pool, { userId: user.id, owner: parsed.data.owner, name: parsed.data.name, repoId });
    if ("error" in result) {
      res.status(409).json({ error: "This repository is already connected." });
      return;
    }
    res.status(201).json({
      project: {
        id: result.project.id,
        owner: result.project.github_owner,
        name: result.project.github_name,
        repoId: Number(result.project.github_repo_id),
        trackingStartedAt: result.project.tracking_started_at.toISOString(),
      },
    });
  });

  app.get("/projects", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const projects = await listProjects(deps.pool, user.id);
    const roles = await listProjectRoles(deps.pool, user.id);
    res.json({
      projects: projects.map((project) => ({
        id: project.id,
        owner: project.github_owner,
        name: project.github_name,
        repoId: Number(project.github_repo_id),
        trackingStartedAt: project.tracking_started_at.toISOString(),
        role: roles.get(project.id) ?? "member",
      })),
    });
  });

  app.get("/projects/:projectId/events", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const projectId = req.params.projectId;
    if (typeof projectId !== "string" || !(await userCanAccessProject(deps.pool, user.id, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const events = await listEvents(deps.pool, projectId);
    res.json({ events });
  });

  app.use(graphRouter({ pool: deps.pool, access: (req, res) => projectMember(deps, req, res) }));
  app.use(
    workspaceRouter({
      pool: deps.pool,
      authenticate: (req, res) => requireUser(deps, req, res),
      member: (req, res) => projectMember(deps, req, res),
      lookupGithubAccount: deps.lookupGithubAccount,
      ...(deps.modelKeyCheck ? { checkModelKey: deps.modelKeyCheck } : {}),
      ...(deps.listSupplierModels ? { listSupplierModels: deps.listSupplierModels } : {}),
    }),
  );

  app.post("/projects/:projectId/helper/pairing-codes", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const projectId = req.params.projectId;
    if (typeof projectId !== "string" || !(await userCanAccessProject(deps.pool, user.id, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const pairing = await createPairingCode(deps.pool, { projectId, userId: user.id });
    res.status(201).json(pairing);
  });

  app.post("/helper/pair", async (req, res) => {
    const parsed = pairBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A pairing code is required." });
      return;
    }
    const exchanged = await exchangePairingCode(deps.pool, {
      code: parsed.data.code,
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
    });
    if ("error" in exchanged) {
      res.status(401).json({ error: "That pairing code is invalid, expired, or already used." });
      return;
    }
    res.status(201).json({
      token: exchanged.token,
      deviceId: exchanged.device.id,
      projectId: exchanged.device.projectId,
      projectName: exchanged.projectName,
      trackingStartedAt: exchanged.device.trackingStartedAt,
    });
  });

  app.delete("/helper/token", async (req, res) => {
    const device = await findHelperDevice(deps.pool, bearerToken(req));
    if (!device) {
      res.status(401).json({ error: "Helper token is missing or revoked." });
      return;
    }
    await revokeHelperToken(deps.pool, bearerToken(req));
    res.status(204).end();
  });

  app.post("/ingest/events", async (req, res) => {
    const parsed = ingestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Event batch is invalid." });
      return;
    }
    const allowed = await canIngest(deps, req, parsed.data.projectId);
    if (allowed === "unauthorized") {
      res.status(401).json({ error: "Sign in or a helper token is required." });
      return;
    }
    if (allowed === "forbidden") {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const result = await ingestEvents(deps.pool, parsed.data);
    res.status(202).json(result);
  });

  return app;
}

async function canIngest(
  deps: AppDeps,
  req: Request,
  projectId: string,
): Promise<"ok" | "unauthorized" | "forbidden"> {
  const token = bearerToken(req);
  if (token === "") {
    return "unauthorized";
  }
  const device = await findHelperDevice(deps.pool, token);
  if (device) {
    return device.projectId === projectId ? "ok" : "forbidden";
  }
  const user = await deps.verifyUser(token);
  if (!user) {
    return "unauthorized";
  }
  return (await userCanAccessProject(deps.pool, user.id, projectId)) ? "ok" : "forbidden";
}
