import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker } from "../change-tracker.js";
import { runCollectionPass } from "../collection-pass.js";
import { LocalDb } from "../local-db.js";
import { flushOutbox, type EventUploadTransport } from "../upload-outbox.js";

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

describe("collection pass", () => {
  it("collects a session on the next scan after its first attempt failed, without holding up the others", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    writeFileSync(join(logs, "a.jsonl"), codexSession("session-a", ["from a"]));
    writeFileSync(join(logs, "b.jsonl"), codexSession("session-b", ["from b"]));
    const db = new LocalDb(join(root, "collector.sqlite"));
    const changes = new ChangeTracker();
    const queue = db.queueAndAdvance.bind(db);
    let failNext = true;
    db.queueAndAdvance = (checkpoint, events) => {
      if (failNext) {
        failNext = false;
        throw new Error("database is locked");
      }
      queue(checkpoint, events);
    };
    const input = { db, projectId, trackingStartedAt, selectedRoots: [workFolder], logRoots: { codex: logs }, changes };

    const first = runCollectionPass(input);
    expect(first.failed).toHaveLength(1);
    expect(new Set(db.pendingEvents().map((item) => item.sessionId)).size).toBe(1);

    const second = runCollectionPass(input);
    expect(second.failed).toEqual([]);
    expect(new Set(db.pendingEvents().map((item) => item.sessionId))).toEqual(new Set(["session-a", "session-b"]));
    db.close();
  });

  it("strips NUL characters, which the server's database cannot store", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    writeFileSync(join(logs, "nul.jsonl"), codexSession("nul-session", ["before\u0000after"]));
    const db = new LocalDb(join(root, "collector.sqlite"));
    runCollectionPass({ db, projectId, trackingStartedAt, selectedRoots: [workFolder], logRoots: { codex: logs } });
    const texts = db
      .pendingEvents()
      .flatMap((item) => (item.event.details.kind === "session.content_added" ? item.event.details.messages : []))
      .map((message) => message.text);
    expect(texts).toEqual(["beforeafter"]);
    db.close();
  });

  it("pauses a session whose log was rewritten in place instead of reading from a shifted offset", () => {
    const root = tempRoot();
    const logs = join(root, "codex");
    mkdirSync(logs);
    const file = join(logs, "rewritten.jsonl");
    const original = codexSession("rewritten-session", ["first"]);
    writeFileSync(file, original);
    const db = new LocalDb(join(root, "collector.sqlite"));
    const input = { db, projectId, trackingStartedAt, selectedRoots: [workFolder], logRoots: { codex: logs } };
    runCollectionPass(input);

    writeFileSync(file, `${original.slice(0, -1)} and a longer line with no newline yet`);
    const second = runCollectionPass(input);
    expect(second.paused).toEqual(["codex:rewritten-session"]);
    expect(db.pausedSessions(projectId)).toEqual([{ provider: "codex", sessionId: "rewritten-session", reason: "truncated" }]);
    db.close();
  });
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
