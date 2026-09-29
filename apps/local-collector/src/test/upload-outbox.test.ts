import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSON_BODY_LIMIT_BYTES, type NormalizedEvent } from "@apm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runCollectionPass } from "../collection-pass.js";
import { LocalDb } from "../local-db.js";
import { flushOutbox, UploadError, uploadBatchLimits, type EventUploadTransport } from "../upload-outbox.js";

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

function acceptingTransport(requests: NormalizedEvent[][]): EventUploadTransport {
  return {
    async send(input) {
      requests.push(input.events);
      return { acknowledged: input.events.map((event) => event.eventId), rejected: [] };
    },
  };
}

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
      expect(Buffer.byteLength(JSON.stringify({ projectId, events }))).toBeLessThan(JSON_BODY_LIMIT_BYTES);
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

  it("drops a single event the API refuses as too large and sends the rest", async () => {
    const db = queueSessions(tempRoot(), 2);
    const huge = db.pendingEvents().find((item) => item.event.details.kind === "session.content_added");
    if (!huge || huge.event.details.kind !== "session.content_added") {
      throw new Error("expected a queued content event");
    }
    // An event queued before content events were split can exceed the request limit on its own.
    const inflated = { ...huge.event, details: { ...huge.event.details, messages: [{ ...huge.event.details.messages[0], text: "z".repeat(600_000) }] } };
    db.db.prepare("update outbox set event_json = ? where event_id = ?").run(JSON.stringify(inflated), huge.eventId);
    const rest = db.pendingEvents().filter((item) => item.eventId !== huge.eventId);
    const sent: string[] = [];
    const result = await flushOutbox(db, {
      async send(input) {
        if (input.events.some((event) => event.eventId === huge?.eventId)) {
          throw new UploadError("Request entity too large", 413);
        }
        sent.push(...input.events.map((event) => event.eventId));
        return { acknowledged: input.events.map((event) => event.eventId), rejected: [] };
      },
    });
    expect(result.rejected).toEqual([{ eventId: huge?.eventId, reason: "too_large" }]);
    expect(sent).toEqual(rest.map((item) => item.eventId));
    expect(db.pendingEvents()).toEqual([]);
    db.close();
  });
});
