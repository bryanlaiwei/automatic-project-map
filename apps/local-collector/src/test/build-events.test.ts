import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSON_BODY_LIMIT_BYTES } from "@apm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { contentEventLimits } from "../build-events.js";
import { runCollectionPass } from "../collection-pass.js";
import { LocalDb } from "../local-db.js";

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
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    }
    const shortened = content
      .flatMap((event) => (event.details.kind === "session.content_added" ? event.details.messages : []))
      .find((message) => message.text.startsWith("xxx"));
    expect(shortened?.text.length).toBe(contentEventLimits.messageChars);
    expect(shortened?.text.endsWith("[message shortened by the local helper]")).toBe(true);
    db.close();
  });
});
