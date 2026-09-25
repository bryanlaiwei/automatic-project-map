import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_CHUNK_REQUEST_LIMIT_BYTES, type NormalizedEvent } from "@apm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker } from "./change-tracker.js";
import { contentEventLimits, runCollectionPass } from "./collect-pass.js";
import { CollectorLoop, defaultLogRoots, uploadBackoffMs } from "./collector-loop.js";
import { flushOutbox, UploadError, uploadBatchLimits, type EventUploadTransport } from "./flush.js";
import { LocalDb } from "./local-db.js";
import { startLocalServer } from "./local-server.js";

const projectId = "33333333-3333-4333-8333-333333333333";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";
const workFolder = "/Projects/loop-app";
const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apm-loop-")));
  temps.push(root);
  return root;
}

function codexSession(id: string, messages: string[], cwd = workFolder): string {
  const lines: unknown[] = [
    { timestamp: "2026-09-24T13:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-24T13:00:00.000Z", cwd } },
    ...messages.map((text, index) => ({
      timestamp: new Date(Date.parse("2026-09-24T13:00:01.000Z") + index * 1000).toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: text },
    })),
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function codexMessage(text: string, at: string): string {
  return JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: text } }) + "\n";
}

function paired(db: LocalDb, deviceId = "device-1"): void {
  db.savePairing({ projectId, trackingStartedAt, apiUrl: "http://127.0.0.1:1", deviceToken: "apm_device", deviceId });
}

function acceptingTransport(requests: NormalizedEvent[][]): EventUploadTransport {
  return {
    async send(input) {
      requests.push(input.events);
      return { acknowledged: input.events.map((event) => event.eventId), rejected: [] };
    },
  };
}

describe("content event size", () => {
  it("splits a long session into events the API accepts and shortens a huge message", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const messages = Array.from({ length: 450 }, (_, index) => `message ${index}`);
    messages[10] = "x".repeat(100_000);
    writeFileSync(join(logs, "long.jsonl"), codexSession("long-session", messages));
    const db = new LocalDb(join(root, "collector.sqlite"));

    runCollectionPass({ db, projectId, trackingStartedAt, selectedRoots: [workFolder], logRoots: { codex: logs } });

    const content = db
      .pendingEvents()
      .map((item) => item.event)
      .filter((event) => event.details.kind === "session.content_added");
    const counts = content.map((event) => (event.details.kind === "session.content_added" ? event.details.messages.length : 0));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(450);
    expect(Math.max(...counts)).toBeLessThanOrEqual(contentEventLimits.messages);
    for (const event of content) {
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(SESSION_CHUNK_REQUEST_LIMIT_BYTES);
    }
    const shortened = content
      .flatMap((event) => (event.details.kind === "session.content_added" ? event.details.messages : []))
      .find((message) => message.text.startsWith("xxx"));
    expect(shortened?.text.length).toBe(contentEventLimits.messageChars);
    expect(shortened?.text.endsWith("[message shortened by the local helper]")).toBe(true);
    db.close();
  });
});

describe("outbox upload", () => {
  function queueSessions(root: string, count: number): LocalDb {
    const logs = join(root, "codex");
    mkdirSync(logs);
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(logs, `s${index}.jsonl`), codexSession(`session-${index}`, [`work ${index}`, "y".repeat(8_000)]));
    }
    const db = new LocalDb(join(root, "collector.sqlite"));
    runCollectionPass({ db, projectId, trackingStartedAt, selectedRoots: [workFolder], logRoots: { codex: logs } });
    return db;
  }

  it("sends a large queue in requests under the API's event and byte limits", async () => {
    const db = queueSessions(tempRoot(), 80);
    expect(db.pendingEvents()).toHaveLength(160);
    const requests: NormalizedEvent[][] = [];

    const result = await flushOutbox(db, acceptingTransport(requests));

    expect(result.acknowledged).toHaveLength(160);
    expect(result.error).toBeNull();
    expect(requests.length).toBeGreaterThan(1);
    for (const events of requests) {
      expect(events.length).toBeLessThanOrEqual(uploadBatchLimits.events);
      expect(Buffer.byteLength(JSON.stringify({ projectId, events }))).toBeLessThan(SESSION_CHUNK_REQUEST_LIMIT_BYTES);
    }
    expect(db.pendingEvents()).toEqual([]);
    db.close();
  });

  it("keeps what failed, and drops what the server rejects for good", async () => {
    const db = queueSessions(tempRoot(), 80);
    let calls = 0;
    const partial = await flushOutbox(db, {
      async send(input) {
        calls += 1;
        if (calls > 1) {
          throw new UploadError("Service unavailable", 503);
        }
        return { acknowledged: input.events.map((event) => event.eventId), rejected: [] };
      },
    });
    expect(partial.acknowledged.length).toBeGreaterThan(0);
    expect(partial.failed).toBe(160 - partial.acknowledged.length);
    expect(partial.unauthorized).toBe(false);
    expect(db.pendingEvents()).toHaveLength(partial.failed);

    const [first, ...rest] = db.pendingEvents();
    const final = await flushOutbox(db, {
      async send(input) {
        return {
          acknowledged: input.events.map((event) => event.eventId).filter((id) => id !== first?.eventId),
          rejected: first && input.events.some((event) => event.eventId === first.eventId) ? [{ eventId: first.eventId, reason: "created_before_tracking" }] : [],
        };
      },
    });
    expect(final.rejected).toEqual([{ eventId: first?.eventId, reason: "created_before_tracking" }]);
    expect(final.acknowledged).toHaveLength(rest.length);
    expect(db.pendingEvents()).toEqual([]);
    db.close();
  });
});

describe("change tracker", () => {
  it("skips a file until its size or modification time changes, and forgets on a new scope", () => {
    const root = tempRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "one\n");
    const tracker = new ChangeTracker();
    tracker.useScope("project-a");
    expect(tracker.unchanged([file])).toBe(false);
    expect(tracker.unchanged([file])).toBe(true);
    appendFileSync(file, "two\n");
    expect(tracker.unchanged([file])).toBe(false);
    utimesSync(file, new Date("2026-09-25T00:00:00Z"), new Date("2026-09-25T00:00:00Z"));
    expect(tracker.unchanged([file])).toBe(false);
    expect(tracker.unchanged([file])).toBe(true);
    tracker.useScope("project-a");
    expect(tracker.unchanged([file])).toBe(true);
    tracker.useScope("project-a with another folder");
    expect(tracker.unchanged([file])).toBe(false);
  });
});

describe("collector loop", () => {
  it("defaults to the Codex and Claude Code log folders and reads Cursor only when configured", () => {
    expect(defaultLogRoots({}, "/home/me")).toEqual({
      codex: "/home/me/.codex/sessions",
      claude_code: "/home/me/.claude/projects",
    });
    expect(defaultLogRoots({ APM_CURSOR_SESSIONS: "/tmp/cursor" }, "/home/me").cursor).toBe("/tmp/cursor");
  });

  it("scans selected folders, uploads new messages once, and backs off while the server is down", async () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const file = join(logs, "work.jsonl");
    writeFileSync(file, codexSession("loop-session", ["first message"]));
    writeFileSync(join(logs, "other.jsonl"), codexSession("other-session", ["elsewhere"], "/Projects/unrelated"));
    const db = new LocalDb(join(root, "collector.sqlite"));

    let now = Date.parse("2026-09-25T15:00:00.000Z");
    const requests: NormalizedEvent[][] = [];
    let mode: "up" | "down" | "revoked" = "up";
    const loop = new CollectorLoop({
      db,
      logRoots: { codex: logs },
      now: () => now,
      transportFor: () => ({
        async send(input) {
          if (mode === "down") {
            throw new UploadError("Service unavailable", 503);
          }
          if (mode === "revoked") {
            throw new UploadError("Sign in or a collector token is required.", 401);
          }
          return acceptingTransport(requests).send(input);
        },
      }),
    });

    expect((await loop.tick()).paired).toBe(false);
    paired(db);
    expect((await loop.tick()).selectedFolders).toBe(0);
    expect(requests).toEqual([]);

    db.addFolder(projectId, workFolder, new Date(now).toISOString());
    const first = await loop.tick();
    expect(requests.flat().map((event) => event.details.kind)).toEqual(["session.started", "session.content_added"]);
    expect(requests.flat().every((event) => event.details.kind !== "session.started" || event.details.sessionId === "loop-session")).toBe(true);
    expect(first).toMatchObject({ paired: true, selectedFolders: 1, queued: 0, uploaded: 2, lastError: null });

    await loop.tick();
    expect(requests).toHaveLength(1);

    mode = "down";
    appendFileSync(file, codexMessage("second message", "2026-09-24T13:05:00.000Z"));
    const failed = await loop.tick();
    expect(failed.queued).toBe(1);
    expect(failed.lastError).toBe("Service unavailable");
    expect(failed.nextUploadAt).toBe(new Date(now + uploadBackoffMs(1)).toISOString());

    mode = "up";
    now += 1_000;
    await loop.tick();
    expect(requests).toHaveLength(1);

    now += uploadBackoffMs(1);
    const recovered = await loop.tick();
    expect(recovered).toMatchObject({ queued: 0, uploaded: 3, lastError: null, nextUploadAt: null });
    const appended = requests[1]?.[0];
    expect(appended?.details.kind === "session.content_added" ? appended.details.messages.map((message) => message.text) : []).toEqual([
      "second message",
    ]);

    mode = "revoked";
    appendFileSync(file, codexMessage("third message", "2026-09-24T13:06:00.000Z"));
    expect((await loop.tick()).needsPairing).toBe(true);

    mode = "up";
    paired(db, "device-2");
    const repaired = await loop.tick();
    expect(repaired).toMatchObject({ needsPairing: false, queued: 0, lastError: null });
    db.close();
  });

  it("does not run two scans at once", async () => {
    const root = tempRoot();
    const db = new LocalDb(join(root, "collector.sqlite"));
    paired(db);
    const loop = new CollectorLoop({ db, logRoots: {} });
    const [a, b] = [loop.tick(), loop.tick()];
    expect(a).toBe(b);
    await a;
    db.close();
  });
});

describe("local helper page", () => {
  async function startHelper(root: string) {
    const db = new LocalDb(join(root, "collector.sqlite"));
    let scans = 0;
    const loop = new CollectorLoop({ db, logRoots: { codex: join(root, "codex") } });
    const server = await startLocalServer({
      db,
      port: 0,
      webOrigin: "http://127.0.0.1:5173",
      logRoots: { codex: join(root, "codex") },
      status: () => loop.status(),
      scanNow: async () => {
        scans += 1;
        return loop.tick();
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ token: "apm_device", deviceId: "device-web", projectId, trackingStartedAt }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const port = (server.address() as AddressInfo).port;
    return { db, server, base: `http://127.0.0.1:${port}`, port, scans: () => scans };
  }

  it("pairs from the web app, then lets a person on this computer choose folders", async () => {
    const root = tempRoot();
    const helper = await startHelper(root);

    const preflight = await fetch(`${helper.base}/pair`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    const pair = await fetch(`${helper.base}/pair`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "web-code", apiUrl: "http://127.0.0.1:4000" }),
    });
    expect(pair.status).toBe(201);
    expect(pair.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(helper.db.getPairing()?.deviceId).toBe("device-web");

    const framed = await fetch(helper.base, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(framed.headers.get("set-cookie")).toBeNull();
    expect(framed.headers.get("x-frame-options")).toBe("DENY");

    const withoutCookie = await fetch(`${helper.base}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(withoutCookie.status).toBe(401);

    const visit = await fetch(helper.base, { headers: { "Sec-Fetch-Dest": "document" } });
    const html = await visit.text();
    expect(html).toContain(`Paired to project ${projectId}`);
    expect(html).toContain(`codex: ${join(root, "codex")}`);
    const cookie = visit.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie.startsWith("apm_local=")).toBe(true);

    const added = await fetch(`${helper.base}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ path: root }),
    });
    expect(added.status).toBe(201);
    expect(helper.db.folders().map((folder) => folder.canonicalPath)).toEqual([root]);
    expect(helper.scans()).toBeGreaterThanOrEqual(2);

    const status = (await (await fetch(`${helper.base}/status`)).json()) as { status: { paired: boolean } };
    expect(status.status.paired).toBe(true);
    helper.server.close();
    helper.db.close();
  });

  it("refuses a request that names another host, so a rebound DNS name cannot reach it", async () => {
    const helper = await startHelper(tempRoot());
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: helper.port, path: "/", headers: { Host: `attacker.example:${helper.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    helper.server.close();
    helper.db.close();
  });
});
