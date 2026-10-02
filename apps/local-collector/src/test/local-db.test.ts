import Database from "better-sqlite3";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, type NormalizedEvent } from "@apm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDb, type PairingRecord } from "../local-db.js";

const projectId = "33333333-3333-4333-8333-333333333333";
const otherProject = "44444444-4444-4444-8444-444444444444";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";
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

function pairing(id: string, deviceToken: string, deviceId: string): PairingRecord {
  return { projectId: id, projectName: `acme/${id.slice(0, 4)}`, trackingStartedAt, apiUrl: "http://127.0.0.1:1", deviceToken, deviceId };
}

function queued(db: LocalDb, project: string, eventId: string): void {
  const event: NormalizedEvent = {
    schemaVersion: SCHEMA_VERSION,
    eventId,
    sourceKey: eventId,
    projectId: project,
    source: "codex",
    occurredAt: "2026-09-24T13:00:00.000Z",
    details: { kind: "session.started", sessionId: `session-${project}`, createdAt: "2026-09-24T13:00:00.000Z", sourceVersion: null },
  } as NormalizedEvent;
  db.queueAndAdvance(
    {
      provider: "codex",
      sessionId: `session-${project}`,
      createdAt: "2026-09-24T13:00:00.000Z",
      projectId: project,
      projectCutoff: trackingStartedAt,
      sourceLocator: "file",
      workingFolder: "/work",
      selectionId: "selection",
      sourceGeneration: "1",
      nextCursor: "10",
      paused: false,
      pauseReason: null,
    },
    [event],
  );
}

describe("pairing", () => {
  it("keeps one pairing per project, and re-pairing a project replaces only its own token", () => {
    const db = new LocalDb(join(tempRoot(), "collector.sqlite"));
    expect(db.savePairing(pairing(projectId, "apm_first", "device-1"))).toBeNull();
    expect(db.savePairing(pairing(otherProject, "apm_other", "device-other"))).toBeNull();
    expect(db.pairings().map((entry) => entry.projectId)).toEqual([projectId, otherProject]);

    const replaced = db.savePairing(pairing(projectId, "apm_second", "device-2"));
    expect(replaced).toMatchObject({ deviceToken: "apm_first" });
    expect(db.pairing(projectId)).toMatchObject({ deviceToken: "apm_second", deviceId: "device-2", projectName: "acme/3333" });
    expect(db.pairing(otherProject)).toMatchObject({ deviceToken: "apm_other" });
    db.close();
  });

  it("removes one project's pairing, folders and queue without touching another project", () => {
    const db = new LocalDb(join(tempRoot(), "collector.sqlite"));
    db.savePairing(pairing(projectId, "apm_first", "device-1"));
    db.savePairing(pairing(otherProject, "apm_other", "device-other"));
    db.addFolder(projectId, "/work/one", trackingStartedAt);
    db.addFolder(otherProject, "/work/two", trackingStartedAt);
    queued(db, projectId, "event-one");
    queued(db, otherProject, "event-two");

    expect(db.removePairing(projectId)).toMatchObject({ deviceToken: "apm_first" });
    expect(db.pairings().map((entry) => entry.projectId)).toEqual([otherProject]);
    expect(db.folders().map((folder) => folder.canonicalPath)).toEqual(["/work/two"]);
    expect(db.pendingEvents().map((event) => event.eventId)).toEqual(["event-two"]);
    expect(db.removePairing(projectId)).toBeNull();
    db.close();
  });

  it("excludes a session for one project only", () => {
    const db = new LocalDb(join(tempRoot(), "collector.sqlite"));
    db.excludeSession("codex", "old-session", otherProject, "created_before_tracking");
    expect(db.isExcluded("codex", "old-session", otherProject)).toBe(true);
    expect(db.isExcluded("codex", "old-session", projectId)).toBe(false);
    db.close();
  });

  it("opens a database written by the one-project helper and keeps its pairing", () => {
    const file = join(tempRoot(), "collector.sqlite");
    const old = new Database(file);
    old.exec(`
      create table excluded_sessions (provider text not null, session_id text not null, reason text not null, primary key (provider, session_id));
      insert into excluded_sessions values ('codex', 'old-session', 'created_before_tracking');
      create table pairing (project_id text primary key, tracking_started_at text not null, api_url text not null, device_token text not null, device_id text not null);
      insert into pairing values ('${projectId}', '${trackingStartedAt}', 'http://127.0.0.1:1', 'apm_old', 'device-old');
    `);
    old.close();

    const db = new LocalDb(file);
    expect(db.pairings()).toEqual([
      { projectId, projectName: null, trackingStartedAt, apiUrl: "http://127.0.0.1:1", deviceToken: "apm_old", deviceId: "device-old" },
    ]);
    expect(db.isExcluded("codex", "old-session", projectId)).toBe(false);
    db.excludeSession("codex", "old-session", projectId, "created_before_tracking");
    expect(db.isExcluded("codex", "old-session", projectId)).toBe(true);
    db.close();
  });
});
