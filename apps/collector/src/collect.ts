import { realpathSync } from "node:fs";
import {
  buildSessionEvents,
  evaluateSessionEligibility,
  ingestedSessionSchema,
  type IngestedSession,
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

  const sessionId = input.parsed.sessionId;
  if (sessionId === null) {
    return { eligible: false, reason: "missing_creation_time", events: [] };
  }

  return {
    eligible: true,
    reason: null,
    events: buildSessionEvents({
      projectId: input.projectId,
      session: {
        source: input.agent,
        sessionId,
        createdAt,
        workingFolder,
        selectedRoots: input.selectedRoots,
        sourceVersion: input.parsed.sourceVersion,
        records: input.parsed.records,
      },
    }),
  };
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

export function loadIngestedSession(input: {
  agent: AgentId;
  filePath: string;
  selectedRoots: string[];
}): IngestedSession {
  const parsed = parseSession(input.agent, input.filePath);
  if (parsed.sessionId === null) {
    throw new Error("This session has no id, so it cannot be uploaded.");
  }
  const workingFolder =
    parsed.ambiguousFolder || parsed.workingFolder === null ? null : resolveFolder(parsed.workingFolder);
  if (parsed.workingFolder !== null && !parsed.ambiguousFolder && workingFolder === null) {
    throw new Error("The session working folder could not be resolved, so it was not uploaded.");
  }
  return ingestedSessionSchema.parse({
    source: input.agent,
    sessionId: parsed.sessionId,
    createdAt: parsed.createdAt,
    workingFolder,
    selectedRoots: input.selectedRoots,
    sourceVersion: parsed.sourceVersion,
    records: parsed.records,
  });
}
