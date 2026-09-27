import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { SCHEMA_VERSION, SESSION_CHUNK_REQUEST_LIMIT_BYTES, sessionAgentSchema } from "@apm/shared";
import type { AuthUser } from "./auth.js";
import type { RepositoryAccessCheck } from "./github-app.js";
import { verifyGithubSignature } from "./github.js";
import { createPairingCode, exchangePairingCode, findCollectorDevice, revokeCollectorToken } from "./collector-tokens.js";
import { graphRouter } from "./graph/routes.js";
import { ingestEvents } from "./ingest-events.js";
import { acceptSessionChunk, getSessionUpload, resetSessionUpload, type SessionUploadView } from "./session-uploads.js";
import {
  connectRepository,
  enqueueDelivery,
  getProjectForUser,
  listEvents,
  listProjects,
  processQueuedDeliveries,
  userCanAccessProject,
  type GithubLookup,
} from "./store.js";

const connectBody = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  repoId: z.number().int().positive(),
});

const chunkBody = z.object({
  projectId: z.string().uuid(),
  source: sessionAgentSchema,
  sessionId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.string(),
  replace: z.boolean().optional(),
});

const chunkQuery = z.object({
  projectId: z.string().uuid(),
  source: sessionAgentSchema,
  sessionId: z.string().min(1),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type AppDeps = {
  pool: Pool;
  webhookSecret: string;
  verifyUser: (token: string) => Promise<AuthUser | null>;
  verifyRepositoryAccess: RepositoryAccessCheck;
  github?: GithubLookup;
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
    await processQueuedDeliveries(deps.pool, deps.github, { deliveryIds: [deliveryId] });
    res.status(202).json({ accepted: true, duplicate: false });
  });

  app.use(express.json({ limit: SESSION_CHUNK_REQUEST_LIMIT_BYTES }));

  app.post("/projects", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const parsed = connectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Repository owner, name, and numeric id are required." });
      return;
    }
    const access = await deps.verifyRepositoryAccess(parsed.data);
    switch (access.status) {
      case "accessible":
        break;
      case "denied":
        res.status(403).json({
          error: "The GitHub App is not installed on this repository, or the repository id does not match.",
        });
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
    const result = await connectRepository(deps.pool, { userId: user.id, ...parsed.data });
    if ("error" in result) {
      const message =
        result.error === "repo_taken"
          ? "This repository is already connected."
          : "This account already has a connected repository.";
      res.status(409).json({ error: message });
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
    res.json({
      projects: projects.map((project) => ({
        id: project.id,
        owner: project.github_owner,
        name: project.github_name,
        repoId: Number(project.github_repo_id),
        trackingStartedAt: project.tracking_started_at.toISOString(),
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

  app.use(
    graphRouter({
      pool: deps.pool,
      access: async (req, res) => {
        const user = await requireUser(deps, req, res);
        if (!user) {
          return null;
        }
        const projectId = req.params.projectId;
        if (typeof projectId !== "string" || !(await userCanAccessProject(deps.pool, user.id, projectId))) {
          res.status(404).json({ error: "Project not found." });
          return null;
        }
        return { userId: user.id, projectId };
      },
    }),
  );

  app.get("/ingest/sessions/chunks", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const contentSha256 = singleQuery(req.query.contentSha256);
    const parsed = chunkQuery.safeParse({
      projectId: singleQuery(req.query.projectId),
      source: singleQuery(req.query.source),
      sessionId: singleQuery(req.query.sessionId),
      ...(contentSha256 ? { contentSha256 } : {}),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Session upload query is invalid." });
      return;
    }
    const project = await getProjectForUser(deps.pool, user.id, parsed.data.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const upload = await getSessionUpload(deps.pool, {
      projectId: parsed.data.projectId,
      source: parsed.data.source,
      sessionId: parsed.data.sessionId,
      contentSha256: parsed.data.contentSha256 ?? null,
    });
    res.json(uploadJson(upload));
  });

  app.delete("/ingest/sessions/chunks", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const parsed = chunkQuery.omit({ contentSha256: true }).safeParse({
      projectId: singleQuery(req.query.projectId),
      source: singleQuery(req.query.source),
      sessionId: singleQuery(req.query.sessionId),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Session upload query is invalid." });
      return;
    }
    const project = await getProjectForUser(deps.pool, user.id, parsed.data.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    await resetSessionUpload(deps.pool, parsed.data);
    res.status(204).end();
  });

  app.post("/projects/:projectId/collector/pairing-codes", async (req, res) => {
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

  app.post("/collector/pair", async (req, res) => {
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
      trackingStartedAt: exchanged.device.trackingStartedAt,
    });
  });

  app.delete("/collector/token", async (req, res) => {
    const device = await findCollectorDevice(deps.pool, bearerToken(req));
    if (!device) {
      res.status(401).json({ error: "Collector token is missing or revoked." });
      return;
    }
    await revokeCollectorToken(deps.pool, bearerToken(req));
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
      res.status(401).json({ error: "Sign in or a collector token is required." });
      return;
    }
    if (allowed === "forbidden") {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const result = await ingestEvents(deps.pool, parsed.data);
    res.status(202).json(result);
  });

  app.post("/ingest/sessions/chunks", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const parsed = chunkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Session chunk is invalid." });
      return;
    }
    const payload = decodeChunkPayload(parsed.data.payload);
    if (!payload) {
      res.status(400).json({ error: "Session chunk payload is not base64." });
      return;
    }
    const project = await getProjectForUser(deps.pool, user.id, parsed.data.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const result = await acceptSessionChunk(deps.pool, {
      projectId: parsed.data.projectId,
      source: parsed.data.source,
      sessionId: parsed.data.sessionId,
      chunkIndex: parsed.data.chunkIndex,
      chunkCount: parsed.data.chunkCount,
      contentSha256: parsed.data.contentSha256,
      payload,
      replace: parsed.data.replace === true,
    });
    if (result.status === "conflict") {
      res.status(409).json({
        error: "This chunk does not match the upload already in progress. Resume that upload or reset it.",
      });
      return;
    }
    if (result.status === "invalid") {
      res.status(400).json({ error: result.message });
      return;
    }
    res.status(result.upload.complete ? 202 : 200).json(uploadJson(result.upload));
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
  const device = await findCollectorDevice(deps.pool, token);
  if (device) {
    return device.projectId === projectId ? "ok" : "forbidden";
  }
  const user = await deps.verifyUser(token);
  if (!user) {
    return "unauthorized";
  }
  return (await userCanAccessProject(deps.pool, user.id, projectId)) ? "ok" : "forbidden";
}

function uploadJson(upload: SessionUploadView) {
  return {
    acknowledged: upload.acknowledged,
    chunkCount: upload.chunkCount,
    contentSha256: upload.contentSha256,
    complete: upload.complete,
    stored: upload.outcome?.stored ?? null,
    reason: upload.outcome?.reason ?? null,
    eventsStored: upload.outcome?.eventsStored ?? null,
  };
}

function singleQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeChunkPayload(payload: string): Buffer | null {
  if (payload.length === 0) {
    return Buffer.alloc(0);
  }
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return null;
  }
  const decoded = Buffer.from(payload, "base64");
  if (decoded.toString("base64") !== payload) {
    return null;
  }
  return decoded;
}
