// Reads one log file and prints whether that session is eligible and which events it would produce.
// The thirty-second scan does not use this command.

import { realpathSync } from "node:fs";
import { evaluateSessionEligibility, type NormalizedEvent } from "@apm/shared";
import { agentById } from "./agents.js";
import { buildEvents } from "./build-events.js";
import type { SessionAgentId } from "./contract/adapter.js";
import type { ParsedSession } from "./contract/session.js";

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
    events: buildEvents({
      projectId: input.projectId,
      agent: input.agent,
      sessionId,
      createdAt,
      sourceVersion: input.parsed.sourceVersion,
      records: input.parsed.records,
      includeStarted: true,
    }),
  };
}

export function collectSession(input: CollectInput): CollectResult {
  return eventsFromParsedSession({
    ...input,
    parsed: agentById(input.agent).readPath(input.filePath),
    resolvePaths: true,
  });
}
