import { realpathSync } from "node:fs";
import {
  evaluateSessionEligibility,
  normalizedEventSchema,
  SCHEMA_VERSION,
  type NormalizedEvent,
} from "@apm/shared";
import { parseClaudeCodeSession } from "./adapters/claude-code.js";
import { parseCodexSession } from "./adapters/codex.js";
import { parseCursorSession } from "./adapters/cursor.js";
import type { ParsedSession } from "./types.js";

export type AgentId = "codex" | "cursor" | "claude_code";

export type CollectInput = {
  agent: AgentId;
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

export function eventsFromParsedSession(input: {
  agent: AgentId;
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

  const decision = evaluateSessionEligibility({
    createdAt: input.parsed.createdAt,
    trackingStartedAt: input.trackingStartedAt,
    workingFolder,
    selectedRoots: input.selectedRoots,
  });

  if (!decision.eligible) {
    return { eligible: false, reason: decision.reason, events: [] };
  }

  const createdAt = input.parsed.createdAt;
  if (createdAt === null) {
    return { eligible: false, reason: "missing_creation_time", events: [] };
  }

  const started = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: `${input.agent}:${input.parsed.sessionId}:started`,
    sourceKey: `${input.agent}:${input.parsed.sessionId}:started`,
    projectId: input.projectId,
    source: input.agent,
    occurredAt: createdAt,
    details: {
      kind: "session.started",
      sessionId: input.parsed.sessionId,
      createdAt,
      sourceVersion: input.parsed.sourceVersion,
    },
  });

  const events = [started];
  if (input.parsed.records.length > 0) {
    events.push(
      normalizedEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: `${input.agent}:${input.parsed.sessionId}:content`,
        sourceKey: `${input.agent}:${input.parsed.sessionId}:content`,
        projectId: input.projectId,
        source: input.agent,
        occurredAt: input.parsed.records[0]?.occurredAt ?? createdAt,
        details: {
          kind: "session.content_added",
          sessionId: input.parsed.sessionId,
          createdAt,
          sourceVersion: input.parsed.sourceVersion,
          recordIds: input.parsed.records.map((record) => record.id),
          messages: input.parsed.records,
        },
      }),
    );
  }

  return { eligible: true, reason: null, events };
}

function parseSession(agent: AgentId, filePath: string): ParsedSession {
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
