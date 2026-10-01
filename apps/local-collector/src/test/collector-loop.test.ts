import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NormalizedEvent } from "@apm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorLoop, defaultLogRoots, uploadBackoffMs } from "../collector-loop.js";
import { LocalDb } from "../local-db.js";
import { UploadError, type EventUploadTransport } from "../upload-outbox.js";

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
            throw new UploadError("Sign in or a helper token is required.", 401);
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

  it("drops queued events of a removed folder before the next upload", async () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    writeFileSync(join(logs, "work.jsonl"), codexSession("removed-session", ["queued while offline"]));
    const db = new LocalDb(join(root, "collector.sqlite"));
    paired(db);
    const folder = db.addFolder(projectId, workFolder, new Date().toISOString());
    let online = false;
    const requests: NormalizedEvent[][] = [];
    let now = Date.parse("2026-09-25T15:00:00.000Z");
    const loop = new CollectorLoop({
      db,
      logRoots: { codex: logs },
      now: () => now,
      transportFor: () => ({
        async send(input) {
          if (!online) {
            throw new UploadError("Service unavailable", 503);
          }
          return acceptingTransport(requests).send(input);
        },
      }),
    });
    expect((await loop.tick()).queued).toBe(2);

    db.setFolderEnabled(folder.id, false);
    online = true;
    now += uploadBackoffMs(1);
    const after = await loop.tick();
    expect(after).toMatchObject({ queued: 0, dropped: 2, lastError: null });
    expect(requests).toEqual([]);
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
