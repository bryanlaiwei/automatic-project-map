import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "@apm/core/auth-user";
import type { Role } from "@apm/shared";

export type ProjectAccess = {
  user: AuthUser;
  projectId: string;
  role: Role;
};

export function requireAccess(
  access: (req: Request, res: Response) => Promise<ProjectAccess | null>,
  level: "member" | "owner" = "member",
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const allowed = await access(req, res);
    if (!allowed) {
      return;
    }
    if (level === "owner" && allowed.role !== "owner") {
      res.status(403).json({ error: "Only project owners can do that." });
      return;
    }
    res.locals.access = allowed;
    next();
  };
}

export function accessFrom(res: Response): ProjectAccess {
  const allowed = res.locals.access as ProjectAccess | undefined;
  if (!allowed) {
    throw new Error("Project access was not checked before this handler.");
  }
  return allowed;
}
