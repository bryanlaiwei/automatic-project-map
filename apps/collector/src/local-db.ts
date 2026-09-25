import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@apm/shared";

export type FolderSelection = {
  id: string;
  projectId: string;
  canonicalPath: string;
  enabledAt: string;
  enabled: boolean;
};

export type SessionCheckpoint = {
  provider: string;
  sessionId: string;
  createdAt: string;
  projectId: string;
  projectCutoff: string;
  sourceLocator: string;
  workingFolder: string;
  selectionId: string;
  sourceGeneration: string;
  nextCursor: string;
  paused: boolean;
  pauseReason: string | null;
};

export type OutboxEvent = {
  eventId: string;
  projectId: string;
  provider: string;
  sessionId: string;
  event: NormalizedEvent;
  attemptCount: number;
  queuedAt: string;
};

export type PairingRecord = {
  projectId: string;
  trackingStartedAt: string;
  apiUrl: string;
  deviceToken: string;
  deviceId: string;
};

const schema = `
create table if not exists meta (
  key text primary key,
  value text not null
);
create table if not exists folder_selections (
  id text primary key,
  project_id text not null,
  canonical_path text not null unique,
  enabled_at text not null,
  enabled integer not null
);
create table if not exists excluded_sessions (
  provider text not null,
  session_id text not null,
  reason text not null,
  primary key (provider, session_id)
);
create table if not exists session_checkpoints (
  provider text not null,
  session_id text not null,
  created_at text not null,
  project_id text not null,
  project_cutoff text not null,
  source_locator text not null,
  working_folder text not null,
  selection_id text not null,
  source_generation text not null,
  next_cursor text not null,
  paused integer not null default 0,
  pause_reason text,
  primary key (provider, session_id, project_id)
);
create table if not exists outbox (
  event_id text primary key,
  project_id text not null,
  provider text not null,
  session_id text not null,
  event_json text not null,
  attempt_count integer not null default 0,
  queued_at text not null,
  last_error text
);
create table if not exists discovery_state (
  provider text primary key,
  discovery_cursor text,
  last_scan text,
  adapter_version text not null
);
create table if not exists pairing (
  project_id text primary key,
  tracking_started_at text not null,
  api_url text not null,
  device_token text not null,
  device_id text not null
);
`;

function sessionIdFromEvent(event: NormalizedEvent, fallback: string): string {
  if (event.details.kind === "session.started" || event.details.kind === "session.content_added") {
    return event.details.sessionId;
  }
  return fallback;
}

export class LocalDb {
  readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  localSecret(): string {
    const existing = this.db.prepare("select value from meta where key = 'local_secret'").get() as
      | { value: string }
      | undefined;
    if (existing) {
      return existing.value;
    }
    const value = randomUUID();
    this.db.prepare("insert into meta (key, value) values ('local_secret', ?)").run(value);
    return value;
  }

  savePairing(pairing: PairingRecord): void {
    this.db
      .prepare(
        `insert into pairing (project_id, tracking_started_at, api_url, device_token, device_id)
         values (@projectId, @trackingStartedAt, @apiUrl, @deviceToken, @deviceId)
         on conflict (project_id) do update set
           tracking_started_at = excluded.tracking_started_at,
           api_url = excluded.api_url,
           device_token = excluded.device_token,
           device_id = excluded.device_id`,
      )
      .run(pairing);
  }

  getPairing(): PairingRecord | null {
    const row = this.db
      .prepare(
        `select project_id as projectId, tracking_started_at as trackingStartedAt, api_url as apiUrl,
                device_token as deviceToken, device_id as deviceId
         from pairing limit 1`,
      )
      .get() as PairingRecord | undefined;
    return row ?? null;
  }

  clearPairing(): void {
    this.db.prepare("delete from pairing").run();
  }

  addFolder(projectId: string, canonicalPath: string, enabledAt: string): FolderSelection {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into folder_selections (id, project_id, canonical_path, enabled_at, enabled)
         values (?, ?, ?, ?, 1)
         on conflict (canonical_path) do update set enabled = 1, project_id = excluded.project_id`,
      )
      .run(id, projectId, canonicalPath, enabledAt);
    const saved = this.folders().find((folder) => folder.canonicalPath === canonicalPath);
    if (!saved) {
      throw new Error("Folder selection was not saved.");
    }
    return saved;
  }

  setFolderEnabled(id: string, enabled: boolean): void {
    this.db.prepare("update folder_selections set enabled = ? where id = ?").run(enabled ? 1 : 0, id);
  }

  folders(): FolderSelection[] {
    const rows = this.db
      .prepare(
        `select id, project_id as projectId, canonical_path as canonicalPath, enabled_at as enabledAt, enabled
         from folder_selections order by enabled_at`,
      )
      .all() as Array<{ id: string; projectId: string; canonicalPath: string; enabledAt: string; enabled: number }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      canonicalPath: row.canonicalPath,
      enabledAt: row.enabledAt,
      enabled: row.enabled === 1,
    }));
  }

  isExcluded(provider: string, sessionId: string): boolean {
    const row = this.db
      .prepare("select 1 as found from excluded_sessions where provider = ? and session_id = ?")
      .get(provider, sessionId) as { found: number } | undefined;
    return row !== undefined;
  }

  excludeSession(provider: string, sessionId: string, reason: string): void {
    this.db
      .prepare(
        `insert into excluded_sessions (provider, session_id, reason) values (?, ?, ?)
         on conflict (provider, session_id) do nothing`,
      )
      .run(provider, sessionId, reason);
  }

  checkpoint(provider: string, sessionId: string, projectId: string): SessionCheckpoint | null {
    const row = this.db
      .prepare(
        `select provider, session_id as sessionId, created_at as createdAt, project_id as projectId,
                project_cutoff as projectCutoff, source_locator as sourceLocator, working_folder as workingFolder,
                selection_id as selectionId, source_generation as sourceGeneration, next_cursor as nextCursor,
                paused, pause_reason as pauseReason
         from session_checkpoints
         where provider = ? and session_id = ? and project_id = ?`,
      )
      .get(provider, sessionId, projectId) as (Omit<SessionCheckpoint, "paused"> & { paused: number }) | undefined;
    if (!row) {
      return null;
    }
    return { ...row, paused: row.paused === 1 };
  }

  /**
   * Events and the reading cursor commit together. A crash before this returns
   * leaves both unchanged.
   */
  queueAndAdvance(checkpoint: SessionCheckpoint, events: NormalizedEvent[]): void {
    const insert = this.db.prepare(
      `insert into outbox (event_id, project_id, provider, session_id, event_json, attempt_count, queued_at)
       values (@eventId, @projectId, @provider, @sessionId, @eventJson, 0, @queuedAt)
       on conflict (event_id) do nothing`,
    );
    const save = this.db.prepare(
      `insert into session_checkpoints (
         provider, session_id, created_at, project_id, project_cutoff, source_locator, working_folder,
         selection_id, source_generation, next_cursor, paused, pause_reason
       ) values (
         @provider, @sessionId, @createdAt, @projectId, @projectCutoff, @sourceLocator, @workingFolder,
         @selectionId, @sourceGeneration, @nextCursor, @paused, @pauseReason
       )
       on conflict (provider, session_id, project_id) do update set
         created_at = excluded.created_at,
         project_cutoff = excluded.project_cutoff,
         source_locator = excluded.source_locator,
         working_folder = excluded.working_folder,
         selection_id = excluded.selection_id,
         source_generation = excluded.source_generation,
         next_cursor = excluded.next_cursor,
         paused = excluded.paused,
         pause_reason = excluded.pause_reason`,
    );
    const queuedAt = new Date().toISOString();
    const run = this.db.transaction(() => {
      for (const event of events) {
        insert.run({
          eventId: event.eventId,
          projectId: event.projectId,
          provider: event.source,
          sessionId: sessionIdFromEvent(event, checkpoint.sessionId),
          eventJson: JSON.stringify(event),
          queuedAt,
        });
      }
      save.run({
        ...checkpoint,
        paused: checkpoint.paused ? 1 : 0,
      });
    });
    run();
  }

  pauseCheckpoint(checkpoint: SessionCheckpoint): void {
    this.queueAndAdvance({ ...checkpoint, paused: true }, []);
  }

  dropQueuedSession(provider: string, sessionId: string): number {
    const result = this.db.prepare("delete from outbox where provider = ? and session_id = ?").run(provider, sessionId);
    return result.changes;
  }

  pendingEvents(): OutboxEvent[] {
    const rows = this.db
      .prepare(
        `select event_id as eventId, project_id as projectId, provider, session_id as sessionId,
                event_json as eventJson, attempt_count as attemptCount, queued_at as queuedAt
         from outbox order by queued_at, rowid`,
      )
      .all() as Array<{
      eventId: string;
      projectId: string;
      provider: string;
      sessionId: string;
      eventJson: string;
      attemptCount: number;
      queuedAt: string;
    }>;
    return rows.map((row) => ({
      eventId: row.eventId,
      projectId: row.projectId,
      provider: row.provider,
      sessionId: row.sessionId,
      event: JSON.parse(row.eventJson) as NormalizedEvent,
      attemptCount: row.attemptCount,
      queuedAt: row.queuedAt,
    }));
  }

  acknowledge(eventIds: string[]): void {
    const remove = this.db.prepare("delete from outbox where event_id = ?");
    const run = this.db.transaction(() => {
      for (const eventId of eventIds) {
        remove.run(eventId);
      }
    });
    run();
  }

  discard(eventIds: string[]): void {
    this.acknowledge(eventIds);
  }

  dropOtherProjects(projectId: string): number {
    return this.db.prepare("delete from outbox where project_id <> ?").run(projectId).changes;
  }

  pausedSessions(projectId: string): Array<{ provider: string; sessionId: string; reason: string | null }> {
    return this.db
      .prepare(
        `select provider, session_id as sessionId, pause_reason as reason
         from session_checkpoints where project_id = ? and paused = 1
         order by provider, session_id`,
      )
      .all(projectId) as Array<{ provider: string; sessionId: string; reason: string | null }>;
  }

  recordFailure(eventIds: string[], message: string): void {
    const update = this.db.prepare(
      "update outbox set attempt_count = attempt_count + 1, last_error = ? where event_id = ?",
    );
    const run = this.db.transaction(() => {
      for (const eventId of eventIds) {
        update.run(message, eventId);
      }
    });
    run();
  }

  noteDiscovery(provider: string, cursor: string, adapterVersion: string): void {
    this.db
      .prepare(
        `insert into discovery_state (provider, discovery_cursor, last_scan, adapter_version)
         values (?, ?, ?, ?)
         on conflict (provider) do update set
           discovery_cursor = excluded.discovery_cursor,
           last_scan = excluded.last_scan,
           adapter_version = excluded.adapter_version`,
      )
      .run(provider, cursor, new Date().toISOString(), adapterVersion);
  }
}
