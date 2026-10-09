// Decides which discovered sessions are eligible and writes their events to SQLite.
// A checkpoint advances only together with the events queued for that session.

import { evaluateSessionEligibility } from "@apm/shared";
import { agents } from "./agents.js";
import { buildEvents } from "./build-events.js";
import type { ChangeTracker } from "./change-tracker.js";
import type { SessionAgentId } from "./contract/adapter.js";
import { discoverSessions, type Discovered } from "./find-sessions.js";
import { LocalDb, type SessionCheckpoint } from "./local-db.js";
import { sliceNewRecords } from "./read-after-offset.js";

export type LogRoots = Partial<Record<SessionAgentId, string>>;

export type CollectPassInput = {
  db: LocalDb;
  projectId: string;
  trackingStartedAt: string;
  selectedRoots: string[];
  logRoots: LogRoots;
  changes?: ChangeTracker;
};

export type CollectPassResult = {
  queuedEventIds: string[];
  excluded: string[];
  paused: string[];
  skipped: string[];
  failed: string[];
};

export function runCollectionPass(input: CollectPassInput): CollectPassResult {
  return prepareIncremental(input);
}

function collectOne(input: CollectPassInput, source: Discovered, result: CollectPassResult): void {
  const label = `${source.agent}:${source.sessionKey}`;
  if (source.parsed.sessionId === null) {
    result.skipped.push(`${label}:missing_creation_time`);
    return;
  }
  const sessionId = source.parsed.sessionId;
  if (input.db.isExcluded(source.agent, sessionId, input.projectId)) {
    result.excluded.push(label);
    return;
  }

  const workingFolder = source.parsed.ambiguousFolder ? null : source.parsed.workingFolder;
  const decision = evaluateSessionEligibility({
    createdAt: source.parsed.createdAt,
    trackingStartedAt: input.trackingStartedAt,
    workingFolder,
    selectedRoots: input.selectedRoots,
  });

  if (!decision.eligible && decision.reason === "created_before_tracking") {
    input.db.excludeSession(source.agent, sessionId, input.projectId, decision.reason);
    input.db.dropQueuedSession(source.agent, sessionId, input.projectId);
    result.excluded.push(label);
    return;
  }
  if (!decision.eligible && decision.reason === "missing_creation_time") {
    result.skipped.push(`${label}:missing_creation_time`);
    return;
  }
  if (!decision.eligible) {
    const existing = input.db.checkpoint(source.agent, sessionId, input.projectId);
    if (existing) {
      input.db.dropQueuedSession(source.agent, sessionId, input.projectId);
    }
    result.skipped.push(`${label}:${decision.reason}`);
    return;
  }

  const createdAt = source.parsed.createdAt;
  if (createdAt === null) {
    result.skipped.push(`${label}:missing_creation_time`);
    return;
  }

  const existing = input.db.checkpoint(source.agent, sessionId, input.projectId);
  if (existing?.paused) {
    result.paused.push(label);
    return;
  }
  if (existing && existing.sourceGeneration !== source.generation) {
    const paused: SessionCheckpoint = {
      ...existing,
      sourceGeneration: source.generation,
      paused: true,
      pauseReason: "source_generation_changed",
    };
    input.db.pauseCheckpoint(paused);
    result.paused.push(label);
    return;
  }
  if (source.truncated) {
    const paused = checkpointFrom(input, source, sessionId, createdAt, decision.matchedRoot, existing?.nextCursor ?? "", true, "truncated");
    input.db.pauseCheckpoint(paused);
    result.paused.push(label);
    return;
  }

  const savedOffset = existing?.nextCursor ?? "";
  if (savedOffset !== "" && savedOffset !== source.byteOffset) {
    result.skipped.push(`${label}:cursor_mismatch`);
    return;
  }

  const events = buildEvents({
    projectId: input.projectId,
    agent: source.agent,
    sessionId,
    createdAt,
    sourceVersion: source.parsed.sourceVersion,
    records: source.newRecords,
    includeStarted: savedOffset === "",
  });
  if (events.length === 0 && existing && existing.nextCursor === source.nextCursor) {
    return;
  }
  const next = checkpointFrom(input, source, sessionId, createdAt, decision.matchedRoot, source.nextCursor, false, null);
  input.db.queueAndAdvance(next, events);
  result.queuedEventIds.push(...events.map((event) => event.eventId));
}

function checkpointFrom(
  input: CollectPassInput,
  source: Discovered,
  sessionId: string,
  createdAt: string,
  matchedRoot: string,
  nextCursor: string,
  paused: boolean,
  pauseReason: string | null,
): SessionCheckpoint {
  const selection = input.db.folders().find((folder) => folder.enabled && folder.canonicalPath === matchedRoot);
  return {
    provider: source.agent,
    sessionId,
    createdAt,
    projectId: input.projectId,
    projectCutoff: input.trackingStartedAt,
    sourceLocator: source.locator.key,
    workingFolder: source.parsed.workingFolder ?? "",
    selectionId: selection?.id ?? matchedRoot,
    sourceGeneration: source.generation,
    nextCursor,
    paused,
    pauseReason,
  };
}

function prepareIncremental(input: CollectPassInput): CollectPassResult {
  const result: CollectPassResult = { queuedEventIds: [], excluded: [], paused: [], skipped: [], failed: [] };
  for (const adapter of agents) {
    const root = input.logRoots[adapter.id];
    if (!root) {
      continue;
    }
    const found = discoverSessions(adapter, root, input.changes);
    for (const source of found) {
      try {
        const sessionId = source.parsed.sessionId;
        const existing = sessionId ? input.db.checkpoint(adapter.id, sessionId, input.projectId) : null;
        const sliced = sliceNewRecords(adapter, source, existing?.nextCursor ?? "");
        collectOne(input, sliced, result);
      } catch (error) {
        // Leave the file unremembered so the next scan tries it again; other sessions carry on.
        result.failed.push(`${adapter.id}:${source.sessionKey}: ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
      if (source.change) {
        input.changes?.remember(source.change);
      }
    }
  }
  return result;
}
