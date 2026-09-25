import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  evaluateSessionEligibility,
  normalizedEventSchema,
  SCHEMA_VERSION,
  type NormalizedEvent,
} from "@apm/shared";
import type { AuthUser } from "./auth.js";
import { verifyGithubSignature } from "./github.js";
import {
  connectRepository,
  enqueueDelivery,
  insertEvents,
  getProjectForUser,
  listEvents,
  listProjects,
  processQueuedDeliveries,
  userCanAccessProject,
} from "./store.js";

const connectBody = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  repoId: z.number().int().positive(),
});

const sessionRecord = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  occurredAt: z.string().datetime(),
});

const ingestBody = z.object({
  projectId: z.string().uuid(),
  sessions: z.array(
    z.object({
      source: z.enum(["codex", "cursor", "claude_code"]),
      sessionId: z.string().min(1),
      createdAt: z.string().datetime().nullable(),
      workingFolder: z.string().nullable(),
      selectedRoots: z.array(z.string()),
      sourceVersion: z.string().nullable(),
      records: z.array(sessionRecord),
    }),
  ),
});

export type AppDeps = {
  pool: Pool;
  webhookSecret: string;
  verifyUser: (token: string) => Promise<AuthUser | null>;
};

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    await processQueuedDeliveries(deps.pool);
    res.status(202).json({ accepted: true, duplicate: false });
  });

  app.use(express.json());

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
    const result = await connectRepository(deps.pool, { userId: user.id, ...parsed.data });
    if ("error" in result) {
      res.status(409).json({ error: "This account already has a connected repository." });
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

  app.post("/ingest/sessions", async (req, res) => {
    const user = await requireUser(deps, req, res);
    if (!user) {
      return;
    }
    const parsed = ingestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Session batch is invalid." });
      return;
    }
    const project = await getProjectForUser(deps.pool, user.id, parsed.data.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const results = [];
    const events: NormalizedEvent[] = [];
    for (const session of parsed.data.sessions) {
      const decision = evaluateSessionEligibility({
        createdAt: session.createdAt,
        trackingStartedAt: project.tracking_started_at.toISOString(),
        workingFolder: session.workingFolder,
        selectedRoots: session.selectedRoots,
      });
      if (!decision.eligible) {
        results.push({ sessionId: session.sessionId, stored: false, reason: decision.reason });
        continue;
      }
      events.push(...buildAcceptedSession(session, parsed.data.projectId));
      results.push({ sessionId: session.sessionId, stored: true, reason: null });
    }
    const stored = await insertEvents(deps.pool, events);
    res.status(202).json({ results, stored });
  });

  return app;
}

function buildAcceptedSession(
  session: z.infer<typeof ingestBody>["sessions"][number],
  projectId: string,
): NormalizedEvent[] {
  if (session.createdAt === null) {
    return [];
  }
  const started = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: `${session.source}:${session.sessionId}:started`,
    sourceKey: `${session.source}:${session.sessionId}:started`,
    projectId,
    source: session.source,
    occurredAt: session.createdAt,
    details: {
      kind: "session.started",
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      sourceVersion: session.sourceVersion,
    },
  });
  const events = [started];
  const first = session.records[0];
  if (first) {
    events.push(
      normalizedEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: `${session.source}:${session.sessionId}:content`,
        sourceKey: `${session.source}:${session.sessionId}:content`,
        projectId,
        source: session.source,
        occurredAt: first.occurredAt,
        details: {
          kind: "session.content_added",
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          sourceVersion: session.sourceVersion,
          recordIds: session.records.map((record) => record.id),
          messages: session.records,
        },
      }),
    );
  }
  return events;
}
