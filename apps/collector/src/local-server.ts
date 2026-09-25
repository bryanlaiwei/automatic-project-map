import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { LocalDb } from "./local-db.js";

const defaultPort = 47321;

export type LocalServerOptions = {
  db: LocalDb;
  port?: number;
  webOrigin?: string;
  fetchImpl?: typeof fetch;
};

export async function startLocalServer(options: LocalServerOptions): Promise<Server> {
  const port = options.port ?? defaultPort;
  const webOrigin = options.webOrigin ?? "http://127.0.0.1:5173";
  const fetchImpl = options.fetchImpl ?? fetch;
  const secret = options.db.localSecret();

  const server = createServer(async (req, res) => {
    if (!isLoopback(req)) {
      send(res, 403, { error: "The helper only accepts connections from this computer." });
      return;
    }
    if (!originAllowed(req, webOrigin, port)) {
      send(res, 403, { error: "This origin is not allowed to talk to the helper." });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req, webOrigin));
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(options.db, hasCookie(req, secret)));
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
        send(res, 201, { paired: true, projectId: payload.projectId }, req, webOrigin, secret);
        return;
      }
      if (!hasCookie(req, secret) && !isFormPost(req)) {
        send(res, 401, { error: "Open the helper page on this computer and pair it first." }, req, webOrigin);
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
        send(res, 201, { folder: saved }, req, webOrigin);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/folders/") && url.pathname.endsWith("/disable")) {
        const id = decodeURIComponent(url.pathname.slice("/folders/".length, -"/disable".length));
        options.db.setFolderEnabled(id, false);
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
    server.listen(port, "127.0.0.1", () => resolve());
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

function page(db: LocalDb, pairedLocally: boolean): string {
  const pairing = db.getPairing();
  const folders = db.folders();
  const folderItems = folders
    .map(
      (folder) =>
        `<li>${escapeHtml(folder.canonicalPath)} ${folder.enabled ? "" : "(paused)"} <form method="post" action="/folders/${encodeURIComponent(folder.id)}/disable"><button type="submit">Remove</button></form></li>`,
    )
    .join("");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Project map helper</title></head>
<body>
<h1>Local helper</h1>
${pairing ? `<p>Paired to project ${escapeHtml(pairing.projectId)}. Tracking started ${escapeHtml(pairing.trackingStartedAt)}.</p>` : `<form id="pair"><label>Pairing code <input name="code" required></label><label>API URL <input name="apiUrl" value="http://127.0.0.1:4000"></label><button type="submit">Pair</button></form>`}
<h2>Folders</h2>
<ul>${folderItems}</ul>
<form id="folder"><label>Folder path <input name="path" required></label><button type="submit">Add folder</button></form>
<p id="message"></p>
<script>
const secretReady = ${pairedLocally ? "true" : "false"};
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function originAllowed(req: IncomingMessage, webOrigin: string, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  const self = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, webOrigin, "http://localhost:5173"]);
  return self.has(origin);
}

function corsHeaders(req: IncomingMessage, webOrigin: string): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (origin && originAllowed(req, webOrigin, 0)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
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
    Object.assign(headers, corsHeaders(req, webOrigin));
  }
  if (cookieSecret) {
    headers["Set-Cookie"] = `apm_local=${cookieSecret}; HttpOnly; SameSite=Lax; Path=/`;
  }
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
