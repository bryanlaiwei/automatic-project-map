import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { applyCorrection } from "@apm/core/graph/corrections";
import { pendingAnalysis, readFeature, readGraph, readRevision, readWorkItem } from "@apm/core/graph/graph-read";
import { correctionSchema, featureResponseSchema, graphRevisionSchema, workItemResponseSchema } from "@apm/shared";
import { accessFrom, requireAccess, type ProjectAccess } from "../require-access.js";

const uuid = z.string().uuid();

export function graphRouter(input: { pool: Pool; access: (req: Request, res: Response) => Promise<ProjectAccess | null> }): Router {
  const router = Router();
  const { pool } = input;
  const asMember = requireAccess(input.access);

  router.get("/projects/:projectId/graph", asMember, async (_req, res) => {
    const allowed = accessFrom(res);
    const graph = await readGraph(pool, allowed.projectId);
    if (!graph) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(graph);
  });

  router.get("/projects/:projectId/graph/revision", asMember, async (_req, res) => {
    const allowed = accessFrom(res);
    res.json(
      graphRevisionSchema.parse({
        revision: await readRevision(pool, allowed.projectId),
        ...(await pendingAnalysis(pool, allowed.projectId)),
      }),
    );
  });

  router.get("/projects/:projectId/work-items/:workItemId", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    const id = uuid.safeParse(req.params.workItemId);
    const item = id.success ? await readWorkItem(pool, allowed.projectId, id.data) : null;
    const revision = await readRevision(pool, allowed.projectId);
    if (!item || revision === null) {
      res.status(404).json({ error: "Work item not found." });
      return;
    }
    res.json(workItemResponseSchema.parse({ revision, workItem: item }));
  });

  router.get("/projects/:projectId/features/:featureId", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    const id = uuid.safeParse(req.params.featureId);
    const feature = id.success ? await readFeature(pool, allowed.projectId, id.data) : null;
    const revision = await readRevision(pool, allowed.projectId);
    if (!feature || revision === null) {
      res.status(404).json({ error: "Feature not found." });
      return;
    }
    res.json(featureResponseSchema.parse({ revision, feature }));
  });

  router.post("/projects/:projectId/corrections", asMember, async (req, res) => {
    const allowed = accessFrom(res);
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Correction is invalid.", issues: parsed.error.issues.map((issue) => issue.message) });
      return;
    }
    const result = await applyCorrection(pool, { projectId: allowed.projectId, userId: allowed.user.id, correction: parsed.data });
    switch (result.status) {
      case "applied":
        res.status(201).json(result);
        return;
      case "not_found":
        res.status(404).json({ error: result.message });
        return;
      case "invalid":
        res.status(400).json({ error: result.message });
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled correction result ${JSON.stringify(unhandled)}`);
      }
    }
  });

  return router;
}
