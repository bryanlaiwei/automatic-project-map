import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCollectionPass } from "./collect-pass.js";
import { flushOutbox, type EventUploadTransport } from "./flush.js";
import { LocalDb } from "./local-db.js";
import { startLocalServer } from "./local-server.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";
const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apm-day2-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function codexLine(input: { id: string; createdAt: string; cwd: string; messages: Array<{ at: string; text: string }> }): string {
  const meta = {
    timestamp: input.createdAt,
    type: "session_meta",
    payload: { id: input.id, timestamp: input.createdAt, cwd: input.cwd, cli_version: "0.130.0" },
  };
  const messages = input.messages.map((message) => ({
    timestamp: message.at,
    type: "event_msg",
    payload: { type: "user_message", message: message.text },
  }));
  return [...[meta], ...messages].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function openDb(root: string): LocalDb {
  return new LocalDb(join(root, "collector.sqlite"));
}

describe("recoverable collection", () => {
  it("ignores a pre-project session even after it is resumed", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    const file = join(logs, "old.jsonl");
    mkdirSync(logs);
    const cwd = "/Projects/my-app";
    writeFileSync(
      file,
      codexLine({
        id: "old-session",
        createdAt: "2026-09-24T11:00:00.000Z",
        cwd,
        messages: [{ at: "2026-09-24T11:00:01.000Z", text: "before tracking" }],
      }),
    );
    const db = openDb(root);
    const first = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(first.queuedEventIds).toEqual([]);
    expect(db.pendingEvents()).toEqual([]);
    expect(db.checkpoint("codex", "old-session", projectId)).toBeNull();

    writeFileSync(
      file,
      codexLine({
        id: "old-session",
        createdAt: "2026-09-24T11:00:00.000Z",
        cwd,
        messages: [
          { at: "2026-09-24T11:00:01.000Z", text: "before tracking" },
          { at: "2026-09-24T13:00:00.000Z", text: "resumed later" },
        ],
      }),
    );
    const second = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(second.queuedEventIds).toEqual([]);
    expect(db.pendingEvents()).toEqual([]);
    db.close();
  });

  it("collects opening messages of a late discovery, then each append once", async () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const cwd = "/Projects/my-app";
    const file = join(logs, "new.jsonl");
    writeFileSync(
      file,
      codexLine({
        id: "new-session",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [{ at: "2026-09-24T18:00:01.000Z", text: "opening message" }],
      }),
    );
    const db = openDb(root);
    const first = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(first.queuedEventIds).toHaveLength(2);
    const opening = db.pendingEvents().find((item) => item.event.details.kind === "session.content_added");
    expect(opening?.event.details.kind === "session.content_added" && opening.event.details.messages.map((message) => message.text)).toEqual([
      "opening message",
    ]);

    writeFileSync(
      file,
      codexLine({
        id: "new-session",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [
          { at: "2026-09-24T18:00:01.000Z", text: "opening message" },
          { at: "2026-09-24T18:05:00.000Z", text: "appended message" },
        ],
      }),
    );
    const second = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(second.queuedEventIds).toHaveLength(1);
    const appended = db.pendingEvents().filter((item) => item.event.details.kind === "session.content_added");
    expect(appended).toHaveLength(2);
    const texts = appended.flatMap((item) =>
      item.event.details.kind === "session.content_added" ? item.event.details.messages.map((message) => message.text) : [],
    );
    expect(texts).toEqual(["opening message", "appended message"]);

    const third = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(third.queuedEventIds).toEqual([]);

    const seen: string[][] = [];
    const transport: EventUploadTransport = {
      async send(input) {
        seen.push(input.events.map((event) => event.eventId));
        throw new Error("offline");
      },
    };
    const failed = await flushOutbox(db, transport);
    expect(failed.acknowledged).toEqual([]);
    expect(db.pendingEvents()).toHaveLength(3);

    const restarted = openDb(root);
    db.close();
    const recovered = await flushOutbox(restarted, {
      async send(input) {
        seen.push(input.events.map((event) => event.eventId));
        return { acknowledged: input.events.map((event) => event.eventId), rejected: [] };
      },
    });
    expect(recovered.acknowledged).toHaveLength(3);
    expect(restarted.pendingEvents()).toEqual([]);
    const again = await flushOutbox(restarted, {
      async send() {
        throw new Error("should not upload twice");
      },
    });
    expect(again.acknowledged).toEqual([]);
    expect(seen[1]).toEqual(seen[0]);
    restarted.close();
  });

  it("keeps independent cursors and waits for a partial line", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const cwd = "/Projects/my-app";
    writeFileSync(
      join(logs, "a.jsonl"),
      codexLine({
        id: "session-a",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [
          { at: "2026-09-24T18:00:01.000Z", text: "from a" },
          { at: "2026-09-24T18:00:02.000Z", text: "from a again" },
        ],
      }),
    );
    writeFileSync(
      join(logs, "b.jsonl"),
      `${codexLine({
        id: "session-b",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [{ at: "2026-09-24T18:00:01.000Z", text: "from b" }],
      })}{"timestamp":"2026-09-24T18:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"partial"`,
    );
    const db = openDb(root);
    runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    const texts = db.pendingEvents().flatMap((item) =>
      item.event.details.kind === "session.content_added" ? item.event.details.messages.map((message) => message.text) : [],
    );
    expect(texts).toEqual(["from a", "from a again", "from b"]);
    expect(texts).not.toContain("partial");
    const cursorA = db.checkpoint("codex", "session-a", projectId)?.nextCursor;
    const cursorB = db.checkpoint("codex", "session-b", projectId)?.nextCursor;
    expect(cursorA).not.toBe(cursorB);
    db.close();
  });

  it("does not replay history when a log is truncated", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const cwd = "/Projects/my-app";
    const file = join(logs, "spin.jsonl");
    writeFileSync(
      file,
      codexLine({
        id: "spin",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [{ at: "2026-09-24T18:00:01.000Z", text: "keep me" }],
      }),
    );
    const db = openDb(root);
    runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    const before = db.pendingEvents().map((item) => item.eventId);
    writeFileSync(
      file,
      codexLine({
        id: "spin",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [],
      }),
    );
    const paused = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(paused.paused).toContain("codex:spin");
    expect(db.pendingEvents().map((item) => item.eventId)).toEqual(before);
    expect(db.checkpoint("codex", "spin", projectId)?.paused).toBe(true);
    db.close();
  });

  it("stops queued uploads when the selected folder is removed", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const cwd = "/Projects/my-app";
    writeFileSync(
      join(logs, "app.jsonl"),
      codexLine({
        id: "app-session",
        createdAt: "2026-09-24T18:00:00.000Z",
        cwd,
        messages: [{ at: "2026-09-24T18:00:01.000Z", text: "in the app" }],
      }),
    );
    const db = openDb(root);
    db.addFolder(projectId, cwd, trackingStartedAt);
    runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [cwd],
      logRoots: { codex: logs },
    });
    expect(db.pendingEvents().length).toBeGreaterThan(0);
    runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: [],
      logRoots: { codex: logs },
    });
    expect(db.pendingEvents()).toEqual([]);
    db.close();
  });

  it("skips an undatable session instead of baselining it", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    writeFileSync(
      join(logs, "nodate.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-09-24T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "no meta" },
      })}\n`,
    );
    const db = openDb(root);
    const result = runCollectionPass({
      db,
      projectId,
      trackingStartedAt,
      selectedRoots: ["/Projects/my-app"],
      logRoots: { codex: logs },
    });
    expect(result.queuedEventIds).toEqual([]);
    expect(result.skipped.some((item) => item.includes("missing_creation_time"))).toBe(true);
    expect(db.checkpoint("codex", "nodate", projectId)).toBeNull();
    db.close();
  });
});

describe("local helper", () => {
  it("pairs from a loopback page and rejects another origin", async () => {
    const root = tempRoot();
    const db = openDb(root);
    let paired = false;
    const server = await startLocalServer({
      db,
      port: 0,
      webOrigin: "http://127.0.0.1:5173",
      fetchImpl: async () => {
        paired = true;
        return new Response(
          JSON.stringify({
            token: "apm_test",
            deviceId: "device-1",
            projectId,
            trackingStartedAt,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("helper did not bind");
    }
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    expect(await page.text()).toContain("Pairing code");
    const denied = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(denied.status).toBe(403);
    expect(paired).toBe(false);
    const accepted = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc", apiUrl: "http://127.0.0.1:4000" }),
    });
    expect(accepted.status).toBe(201);
    expect(db.getPairing()?.projectId).toBe(projectId);
    expect(db.getPairing()?.deviceToken).toBe("apm_test");
    server.close();
    db.close();
  });
});

