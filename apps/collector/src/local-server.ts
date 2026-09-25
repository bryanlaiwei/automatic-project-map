import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { LogRoots } from "./collect-pass.js";
import { describeLogRoots, type CollectorStatus } from "./collector-loop.js";
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
  const secret = options.db.localSecret();

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
        const headers: Record<string, string> = {
          "Content-Type": "text/html; charset=utf-8",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "frame-ancestors 'none'",
        };
        if (isTopLevelVisit(req)) {
          headers["Set-Cookie"] = sessionCookie(secret);
        }
        res.writeHead(200, headers);
        res.end(page(options.db, options.logRoots ?? {}, options.status?.() ?? null));
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
        const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/collector/pair`, {
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
        send(res, 201, { paired: true, projectId: payload.projectId }, req, webOrigin, secret);
        return;
      }
      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, { status: options.status?.() ?? null }, req, webOrigin);
        return;
      }
      if (!hasCookie(req, secret) && !isFormPost(req)) {
        send(res, 401, { error: "Open the helper page on this computer first." }, req, webOrigin);
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
        if (isFormPost(req)) {
          res.writeHead(303, { Location: "/" });
          res.end();
          return;
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

function page(db: LocalDb, logRoots: LogRoots, status: CollectorStatus | null): string {
  const pairing = db.getPairing();
  const folders = db.folders();
  const folderItems = folders
    .map(
      (folder) =>
        `<li>${escapeHtml(folder.canonicalPath)} ${folder.enabled ? "" : "(paused)"} <form method="post" action="/folders/${encodeURIComponent(folder.id)}/disable"><button type="submit">Remove</button></form></li>`,
    )
    .join("");
  const pairForm = `<form id="pair"><label>Pairing code <input name="code" required></label><label>API URL <input name="apiUrl" value="${escapeHtml(pairing?.apiUrl ?? "http://127.0.0.1:4000")}"></label><button type="submit">Pair</button></form>`;
  const pairingSection = !pairing
    ? `<p>Not paired yet. Use "Connect local helper" in the web app, or paste a pairing code here.</p>${pairForm}`
    : status?.needsPairing
      ? `<p>The server no longer accepts this helper's token. Connect it again from the web app, or paste a new code.</p>${pairForm}`
      : `<p>Paired to project ${escapeHtml(pairing.projectId)}. Tracking started ${escapeHtml(pairing.trackingStartedAt)}.</p>`;
  const roots = describeLogRoots(logRoots)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Project map helper</title></head>
<body>
<h1>Local helper</h1>
${pairingSection}
<h2>Folders</h2>
<p>Only sessions whose working folder is inside one of these folders are uploaded.</p>
<ul>${folderItems}</ul>
<form id="folder"><label>Folder path <input name="path" required></label><button type="submit">Add folder</button></form>
<h2>Collection</h2>
<p>Agent logs watched:</p>
<ul>${roots}</ul>
${statusSection(status)}
<p id="message"></p>
<script>
document.getElementById("scan")?.addEventListener("click", async () => {
  const response = await fetch("/scan", { method: "POST" });
  const body = await response.json().catch(() => ({}));
  document.getElementById("message").textContent = response.ok ? "Scan finished." : (body.error || "Scan failed.");
  if (response.ok) location.reload();
});
document.getElementById("pair")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const response = await fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: data.get("code"), apiUrl: data.get("apiUrl") }) });
  const body = await response.json().catch(() => ({}));
  document.getElementById("message").textContent = response.ok ? "Paired." : (body.error || "Pairing failed.");
  if (response.ok) location.reload();
});
document.getElementById("folder")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const response = await fetch("/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: data.get("path") }) });
  const body = await response.json().catch(() => ({}));
  document.getElementById("message").textContent = response.ok ? "Folder added." : (body.error || "Could not add that folder.");
  if (response.ok) location.reload();
});
</script>
</body>
</html>`;
}

function statusSection(status: CollectorStatus | null): string {
  if (!status) {
    return "";
  }
  const paused = status.paused
    .map((item) => `<li>${escapeHtml(item.provider)} ${escapeHtml(item.sessionId)}: ${escapeHtml(item.reason ?? "paused")}</li>`)
    .join("");
  const lines = [
    `Last scan: ${status.lastScanAt ?? "not yet"}`,
    `Last upload: ${status.lastUploadAt ?? "not yet"}`,
    `Waiting to upload: ${status.queued}`,
    `Uploaded since start: ${status.uploaded}`,
    `Dropped since start: ${status.dropped}`,
    ...(status.nextUploadAt ? [`Next upload attempt: ${status.nextUploadAt}`] : []),
    ...(status.lastError ? [`Last problem: ${status.lastError}`] : []),
  ];
  return `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
${paused === "" ? "" : `<p>Paused sessions (their log file was replaced or shortened):</p><ul>${paused}</ul>`}
<button id="scan" type="button">Scan now</button>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
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

/**
 * Opening the page in a tab proves the person is at this computer. Frames and
 * scripted requests from other pages do not get the cookie.
 */
function isTopLevelVisit(req: IncomingMessage): boolean {
  const destination = req.headers["sec-fetch-dest"];
  return destination === undefined || destination === "document";
}

function sessionCookie(secret: string): string {
  return `apm_local=${secret}; HttpOnly; SameSite=Lax; Path=/`;
}

function hasCookie(req: IncomingMessage, secret: string): boolean {
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").some((part) => part.trim() === `apm_local=${secret}`);
}

function isFormPost(req: IncomingMessage): boolean {
  return req.method === "POST" && (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
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
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  req?: IncomingMessage,
  webOrigin?: string,
  cookieSecret?: string,
): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req && webOrigin) {
    Object.assign(headers, corsHeaders(req, webOrigin, req.socket.localPort ?? 0));
  }
  if (cookieSecret) {
    headers["Set-Cookie"] = sessionCookie(cookieSecret);
  }
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
