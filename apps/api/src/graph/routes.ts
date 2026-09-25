import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { applyCorrection, correctionSchema } from "./corrections.js";
import { readFeature, readGraph, readRevision, readWorkItem } from "./graph-read.js";

export type ProjectAccess = (req: Request, res: Response) => Promise<{ userId: string; projectId: string } | null>;

const uuid = z.string().uuid();

export function graphRouter(input: { pool: Pool; access: ProjectAccess }): Router {
  const router = Router();
  const { pool, access } = input;

  router.get("/projects/:projectId/graph", async (req, res) => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    res.json(await readGraph(pool, allowed.projectId));
  });

  router.get("/projects/:projectId/graph/revision", async (req, res) => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    res.json({ revision: await readRevision(pool, allowed.projectId) });
  });

  router.get("/projects/:projectId/work-items/:workItemId", async (req, res) => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    const id = uuid.safeParse(req.params.workItemId);
    const item = id.success ? await readWorkItem(pool, allowed.projectId, id.data) : null;
    if (!item) {
      res.status(404).json({ error: "Work item not found." });
      return;
    }
    res.json({ revision: await readRevision(pool, allowed.projectId), workItem: item });
  });

  router.get("/projects/:projectId/features/:featureId", async (req, res) => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    const id = uuid.safeParse(req.params.featureId);
    const feature = id.success ? await readFeature(pool, allowed.projectId, id.data) : null;
    if (!feature) {
      res.status(404).json({ error: "Feature not found." });
      return;
    }
    res.json({ revision: await readRevision(pool, allowed.projectId), feature });
  });

  router.post("/projects/:projectId/corrections", async (req, res) => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Correction is invalid.", issues: parsed.error.issues.map((issue) => issue.message) });
      return;
    }
    const result = await applyCorrection(pool, { projectId: allowed.projectId, userId: allowed.userId, correction: parsed.data });
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
