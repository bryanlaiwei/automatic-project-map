// HTTP API on this computer that the web app uses to pair, choose folders, and see helper status.
// It accepts connections only from this machine. The pages themselves live in the web app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { agents } from "./agents.js";
import type { LogRoots } from "./collection-pass.js";
import type { CollectorStatus } from "./collector-loop.js";
import { LocalDb } from "./local-db.js";

const defaultPort = 47321;

export type LocalServerOptions = {
  db: LocalDb;
  port?: number;
  webOrigin?: string;
  fetchImpl?: typeof fetch;
  logRoots?: LogRoots;
  status?: () => CollectorStatus;
  scanNow?: () => Promise<unknown>;
};

export async function startLocalServer(options: LocalServerOptions): Promise<Server> {
  const webOrigin = options.webOrigin ?? "http://127.0.0.1:5173";
  const fetchImpl = options.fetchImpl ?? fetch;

  const server = createServer(async (req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (!isLoopback(req) || !hostAllowed(req, port)) {
      send(res, 403, { error: "The helper only accepts connections from this computer." });
      return;
    }
    if (!originAllowed(req, webOrigin, port)) {
      send(res, 403, { error: "This origin is not allowed to talk to the helper." });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req, webOrigin, port));
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const pairing = options.db.getPairing();
        send(
          res,
          200,
          {
            pairing: pairing
              ? { projectId: pairing.projectId, trackingStartedAt: pairing.trackingStartedAt, apiUrl: pairing.apiUrl }
              : null,
            folders: options.db.folders().map((folder) => ({
              id: folder.id,
              canonicalPath: folder.canonicalPath,
              enabled: folder.enabled,
            })),
            logRoots: logRootList(options.logRoots ?? {}),
            status: options.status?.() ?? null,
          },
          req,
          webOrigin,
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/pair") {
        const body = await readJson(req);
        const code = typeof body.code === "string" ? body.code.trim() : "";
        const apiUrl = typeof body.apiUrl === "string" && body.apiUrl.trim() !== "" ? body.apiUrl.trim() : "http://127.0.0.1:4000";
        if (code === "") {
          send(res, 400, { error: "A pairing code is required." }, req, webOrigin);
          return;
        }
        const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/helper/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isPairPayload(payload)) {
          const message =
            typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : "Pairing failed.";
          send(res, 401, { error: message }, req, webOrigin);
          return;
        }
        options.db.savePairing({
          projectId: payload.projectId,
          trackingStartedAt: payload.trackingStartedAt,
          apiUrl,
          deviceToken: payload.token,
          deviceId: payload.deviceId,
        });
        void options.scanNow?.();
        send(res, 201, { paired: true, projectId: payload.projectId }, req, webOrigin);
        return;
      }
      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, { status: options.status?.() ?? null }, req, webOrigin);
        return;
      }
      if (!fromWebApp(req, webOrigin, port)) {
        send(res, 401, { error: "Open the helper from the web app on this computer." }, req, webOrigin);
        return;
      }
      if (req.method === "POST" && url.pathname === "/scan") {
        await options.scanNow?.();
        send(res, 200, { status: options.status?.() ?? null }, req, webOrigin);
        return;
      }
      if (req.method === "POST" && url.pathname === "/folders") {
        const body = await readJson(req);
        const folderPath = typeof body.path === "string" ? body.path.trim() : "";
        const pairing = options.db.getPairing();
        if (!pairing) {
          send(res, 409, { error: "Pair the helper before selecting folders." }, req, webOrigin);
          return;
        }
        let canonical: string;
        try {
          canonical = realpathSync(folderPath);
        } catch {
          send(res, 400, { error: "That folder does not exist." }, req, webOrigin);
          return;
        }
        const saved = options.db.addFolder(pairing.projectId, canonical, new Date().toISOString());
        void options.scanNow?.();
        send(res, 201, { folder: saved }, req, webOrigin);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/folders/") && url.pathname.endsWith("/disable")) {
        const id = decodeURIComponent(url.pathname.slice("/folders/".length, -"/disable".length));
        options.db.setFolderEnabled(id, false);
        const paired = options.db.getPairing();
        if (paired) {
          options.db.dropUnselected(paired.projectId, options.db.enabledRoots(paired.projectId));
        }
        send(res, 204, null, req, webOrigin);
        return;
      }
      send(res, 404, { error: "Not found." }, req, webOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Helper request failed.";
      send(res, 500, { error: message }, req, webOrigin);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? defaultPort, "127.0.0.1", () => resolve());
  });
  return server;
}

function isPairPayload(value: unknown): value is { token: string; deviceId: string; projectId: string; trackingStartedAt: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === "string" &&
    typeof record.deviceId === "string" &&
    typeof record.projectId === "string" &&
    typeof record.trackingStartedAt === "string"
  );
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Rejects requests whose Host is not this computer, so a rebound DNS name cannot reach the helper. */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function logRootList(roots: LogRoots): Array<{ id: string; path: string }> {
  return agents.flatMap((agent) => {
    const path = roots[agent.id];
    return path ? [{ id: agent.id, path }] : [];
  });
}

/** Folder changes come from the web app, which sends its origin. Other callers do not. */
function fromWebApp(req: IncomingMessage, webOrigin: string, port: number): boolean {
  return typeof req.headers.origin === "string" && originAllowed(req, webOrigin, port);
}

function originAllowed(req: IncomingMessage, webOrigin: string, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  const self = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, webOrigin, "http://localhost:5173"]);
  return self.has(origin);
}

function corsHeaders(req: IncomingMessage, webOrigin: string, port: number): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (origin && originAllowed(req, webOrigin, port)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage, webOrigin?: string): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req && webOrigin) {
    Object.assign(headers, corsHeaders(req, webOrigin, req.socket.localPort ?? 0));
  }
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
