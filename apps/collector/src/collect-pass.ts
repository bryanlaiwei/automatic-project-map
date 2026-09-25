import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateSessionEligibility,
  normalizedEventSchema,
  SCHEMA_VERSION,
  sessionContentEventId,
  type NormalizedEvent,
  type SessionMessage,
} from "@apm/shared";
import { parseClaudeCodeText } from "./adapters/claude-code.js";
import { parseCodexText } from "./adapters/codex.js";
import { parseCursorText } from "./adapters/cursor.js";
import { completePrefixEnd, fileGeneration } from "./lines.js";
import { LocalDb, type SessionCheckpoint } from "./local-db.js";
import type { ParsedSession } from "./types.js";

export type AgentId = "codex" | "cursor" | "claude_code";

export type LogRoots = Partial<Record<AgentId, string>>;

export type CollectPassInput = {
  db: LocalDb;
  projectId: string;
  trackingStartedAt: string;
  selectedRoots: string[];
  logRoots: LogRoots;
};

export type CollectPassResult = {
  queuedEventIds: string[];
  excluded: string[];
  paused: string[];
  skipped: string[];
};

const adapterVersion = "day2";

export function runCollectionPass(input: CollectPassInput): CollectPassResult {
  return prepareIncremental(input);
}

type Discovered = {
  agent: AgentId;
  sessionKey: string;
  locator: string;
  parsed: ParsedSession;
  generation: string;
  cursor: string;
  nextCursor: string;
  newRecords: SessionMessage[];
  truncated: boolean;
};

function collectOne(input: CollectPassInput, source: Discovered, result: CollectPassResult): void {
  const label = `${source.agent}:${source.sessionKey}`;
  if (source.parsed.sessionId === null) {
    result.skipped.push(`${label}:missing_creation_time`);
    return;
  }
  const sessionId = source.parsed.sessionId;
  if (input.db.isExcluded(source.agent, sessionId)) {
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
    input.db.excludeSession(source.agent, sessionId, decision.reason);
    input.db.dropQueuedSession(source.agent, sessionId);
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
      input.db.dropQueuedSession(source.agent, sessionId);
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

  const cursor = existing?.nextCursor ?? "";
  if (cursor !== "" && cursor !== source.cursor) {
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
    includeStarted: cursor === "",
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
    sourceLocator: source.locator,
    workingFolder: source.parsed.workingFolder ?? "",
    selectionId: selection?.id ?? matchedRoot,
    sourceGeneration: source.generation,
    nextCursor,
    paused,
    pauseReason,
  };
}

function buildEvents(input: {
  projectId: string;
  agent: AgentId;
  sessionId: string;
  createdAt: string;
  sourceVersion: string | null;
  records: SessionMessage[];
  includeStarted: boolean;
}): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (input.includeStarted) {
    const startedId = `${input.agent}:${input.sessionId}:started`;
    events.push(
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
    );
  }
  const first = input.records[0];
  if (!first) {
    return events;
  }
  const contentId = sessionContentEventId(input.agent, input.sessionId, input.records);
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
        recordIds: input.records.map((record) => record.id),
        messages: input.records,
      },
    }),
  );
  return events;
}

function discover(agent: AgentId, root: string): Discovered[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const found: Discovered[] = [];
  if (agent === "cursor") {
    for (const directory of walkDirectories(root)) {
      const sessionPath = join(directory, "session.json");
      const transcriptPath = join(directory, "transcript.jsonl");
      if (!exists(sessionPath) || !exists(transcriptPath)) {
        continue;
      }
      const source = safely(() => readCursor(directory, sessionPath, transcriptPath));
      if (source) {
        found.push(source);
      }
    }
    return found;
  }
  for (const filePath of walkFiles(root, ".jsonl")) {
    const source = safely(() => (agent === "codex" ? readCodex(filePath) : readClaude(filePath)));
    if (source) {
      found.push(source);
    }
  }
  return found;
}

function safely(read: () => Discovered): Discovered | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function readCodex(filePath: string): Discovered {
  return readJsonlSession("codex", filePath, parseCodexText);
}

function readClaude(filePath: string): Discovered {
  return readJsonlSession("claude_code", filePath, parseClaudeCodeText);
}

function readJsonlSession(agent: "codex" | "claude_code", filePath: string, parse: (text: string) => ParsedSession): Discovered {
  const bytes = readFileSync(filePath);
  const generation = fileGeneration(filePath);
  const completeEnd = completePrefixEnd(bytes);
  const completeText = bytes.subarray(0, completeEnd).toString("utf8");
  const parsed = completeText === "" ? emptyParsed() : parse(completeText);
  return {
    agent,
    sessionKey: parsed.sessionId ?? filePath,
    locator: filePath,
    parsed,
    generation,
    cursor: "0",
    nextCursor: String(completeEnd),
    newRecords: parsed.records,
    truncated: false,
  };
}

function readCursor(directory: string, sessionPath: string, transcriptPath: string): Discovered {
  const transcript = readFileSync(transcriptPath);
  const generation = fileGeneration(transcriptPath);
  const completeEnd = completePrefixEnd(transcript);
  let parsed = emptyParsed();
  try {
    parsed = parseCursorText(readFileSync(sessionPath, "utf8"), transcript.subarray(0, completeEnd).toString("utf8"));
  } catch {
    parsed = emptyParsed();
  }
  return {
    agent: "cursor",
    sessionKey: parsed.sessionId ?? directory,
    locator: directory,
    parsed,
    generation,
    cursor: "0",
    nextCursor: String(completeEnd),
    newRecords: parsed.records,
    truncated: false,
  };
}

export function sliceNewRecords(source: Discovered, cursor: string): Discovered {
  const offset = cursor === "" ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ...source, truncated: true, newRecords: [], cursor };
  }
  const filePath = source.agent === "cursor" ? join(source.locator, "transcript.jsonl") : source.locator;
  const bytes = readFileSync(filePath);
  if (bytes.length < offset) {
    return { ...source, truncated: true, newRecords: [], cursor };
  }
  const completeEnd = completePrefixEnd(bytes);
  if (offset > completeEnd) {
    return { ...source, newRecords: [], cursor, nextCursor: String(completeEnd) };
  }
  const fresh = source.agent === "cursor" ? readCursor(source.locator, join(source.locator, "session.json"), filePath) : source.agent === "codex" ? readCodex(filePath) : readClaude(filePath);
  if (offset === 0) {
    return { ...fresh, cursor: "" };
  }
  const newText = bytes.subarray(offset, completeEnd).toString("utf8");
  const parsedNew =
    source.agent === "codex"
      ? parseCodexText(newText)
      : source.agent === "claude_code"
        ? parseClaudeCodeText(newText)
        : parseCursorText(readFileSync(join(source.locator, "session.json"), "utf8"), newText);
  return {
    ...fresh,
    cursor,
    newRecords: parsedNew.records,
    parsed: fresh.parsed,
  };
}

function emptyParsed(): ParsedSession {
  return {
    sessionId: null,
    createdAt: null,
    workingFolder: null,
    sourceVersion: null,
    records: [],
    ambiguousFolder: false,
  };
}

function exists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function walkFiles(root: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(full, extension));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension) && entry.name !== "transcript.jsonl") {
      found.push(full);
    }
  }
  return found;
}

function walkDirectories(root: string): string[] {
  const found = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    found.push(...walkDirectories(join(root, entry.name)));
  }
  return found;
}

export function prepareIncremental(input: CollectPassInput): CollectPassResult {
  const result: CollectPassResult = { queuedEventIds: [], excluded: [], paused: [], skipped: [] };
  const agents: AgentId[] = ["codex", "cursor", "claude_code"];
  for (const agent of agents) {
    const root = input.logRoots[agent];
    if (!root) {
      continue;
    }
    const found = discover(agent, root);
    input.db.noteDiscovery(agent, String(found.length), adapterVersion);
    for (const source of found) {
      const sessionId = source.parsed.sessionId;
      const existing = sessionId ? input.db.checkpoint(agent, sessionId, input.projectId) : null;
      const sliced = sliceNewRecords(source, existing?.nextCursor ?? "");
      collectOne(input, sliced, result);
    }
  }
  return result;
}
