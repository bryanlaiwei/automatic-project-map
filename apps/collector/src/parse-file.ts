// Reads one log file and prints whether that session is eligible and which events it would produce.
// The thirty-second scan does not use this command.

import { realpathSync } from "node:fs";
import {
  evaluateSessionEligibility,
  normalizedEventSchema,
  SCHEMA_VERSION,
  sessionContentEventId,
  type NormalizedEvent,
  type SessionMessage,
} from "@apm/shared";
import { parseClaudeCodeSession } from "./adapters/claude-code.js";
import { parseCodexSession } from "./adapters/codex.js";
import { parseCursorSession } from "./adapters/cursor.js";
import { contentGroups } from "./build-events.js";
import type { SessionAgentId } from "./contract/adapter.js";
import type { ParsedSession } from "./contract/types.js";

export type CollectInput = {
  agent: SessionAgentId;
  filePath: string;
  projectId: string;
  trackingStartedAt: string;
  selectedRoots: string[];
};

export type CollectResult = {
  eligible: boolean;
  reason: string | null;
  events: NormalizedEvent[];
};

function resolveFolder(folder: string): string | null {
  try {
    return realpathSync(folder);
  } catch {
    return null;
  }
}

function resolveSelectedRoots(roots: string[], resolvePaths: boolean): string[] {
  if (!resolvePaths) {
    return roots;
  }
  // On macOS /tmp is a symlink to /private/tmp. Resolve the selected roots
  // the same way as the session folder, or a real match is rejected.
  return roots.map((root) => resolveFolder(root) ?? root);
}

export function eventsFromParsedSession(input: {
  agent: SessionAgentId;
  parsed: ParsedSession;
  projectId: string;
  trackingStartedAt: string;
  selectedRoots: string[];
  resolvePaths: boolean;
}): CollectResult {
  if (input.parsed.ambiguousFolder) {
    return { eligible: false, reason: "missing_folder", events: [] };
  }
  if (input.parsed.sessionId === null) {
    return { eligible: false, reason: "missing_creation_time", events: [] };
  }

  const workingFolder =
    input.parsed.workingFolder === null
      ? null
      : input.resolvePaths
        ? resolveFolder(input.parsed.workingFolder)
        : input.parsed.workingFolder;

  if (input.parsed.workingFolder !== null && workingFolder === null) {
    return { eligible: false, reason: "missing_folder", events: [] };
  }

  const selectedRoots = resolveSelectedRoots(input.selectedRoots, input.resolvePaths);
  const decision = evaluateSessionEligibility({
    createdAt: input.parsed.createdAt,
    trackingStartedAt: input.trackingStartedAt,
    workingFolder,
    selectedRoots,
  });

  if (!decision.eligible) {
    return { eligible: false, reason: decision.reason, events: [] };
  }

  const createdAt = input.parsed.createdAt;
  if (createdAt === null) {
    return { eligible: false, reason: "missing_creation_time", events: [] };
  }

  const sessionId = input.parsed.sessionId;
  if (sessionId === null) {
    return { eligible: false, reason: "missing_creation_time", events: [] };
  }

  return {
    eligible: true,
    reason: null,
    events: sessionEvents({
      projectId: input.projectId,
      agent: input.agent,
      sessionId,
      createdAt,
      sourceVersion: input.parsed.sourceVersion,
      records: input.parsed.records,
    }),
  };
}

function sessionEvents(input: {
  projectId: string;
  agent: SessionAgentId;
  sessionId: string;
  createdAt: string;
  sourceVersion: string | null;
  records: SessionMessage[];
}): NormalizedEvent[] {
  const startedId = `${input.agent}:${input.sessionId}:started`;
  const events: NormalizedEvent[] = [
    normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: startedId,
      sourceKey: startedId,
      projectId: input.projectId,
      source: input.agent,
      occurredAt: input.createdAt,
      details: {
        kind: "session.started",
        sessionId: input.sessionId,
        createdAt: input.createdAt,
        sourceVersion: input.sourceVersion,
      },
    }),
  ];
  for (const records of contentGroups(input.records)) {
    const first = records[0];
    if (!first) {
      continue;
    }
    const contentId = sessionContentEventId(input.agent, input.sessionId, records);
    events.push(
      normalizedEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: contentId,
        sourceKey: contentId,
        projectId: input.projectId,
        source: input.agent,
        occurredAt: first.occurredAt,
        details: {
          kind: "session.content_added",
          sessionId: input.sessionId,
          createdAt: input.createdAt,
          sourceVersion: input.sourceVersion,
          recordIds: records.map((record) => record.id),
          messages: records,
        },
      }),
    );
  }
  return events;
}

function parseSession(agent: SessionAgentId, filePath: string): ParsedSession {
  switch (agent) {
    case "codex":
      return parseCodexSession(filePath);
    case "claude_code":
      return parseClaudeCodeSession(filePath);
    case "cursor":
      return parseCursorSession(filePath);
    default: {
      const unexpected: never = agent;
      throw new Error(`Unknown agent: ${unexpected}`);
    }
  }
}

export function collectSession(input: CollectInput): CollectResult {
  return eventsFromParsedSession({
    ...input,
    parsed: parseSession(input.agent, input.filePath),
    resolvePaths: true,
  });
}
