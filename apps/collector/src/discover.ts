// Finds session files under an agent's log directory and reads the ones the change tracker has not already seen.
// Each result is the parsed session and the byte offset of its last complete line.

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "@apm/shared";
import { parseClaudeCodeText } from "./adapters/claude-code.js";
import { parseCodexText } from "./adapters/codex.js";
import { parseCursorText } from "./adapters/cursor.js";
import type { ChangeTracker, FileChange } from "./change-tracker.js";
import type { SessionAgentId, SessionLocator } from "./contract/adapter.js";
import type { ParsedSession } from "./contract/types.js";
import { completePrefixEnd, fileGeneration } from "./lines.js";

export type Discovered = {
  agent: SessionAgentId;
  sessionKey: string;
  locator: string;
  parsed: ParsedSession;
  generation: string;
  byteOffset: string;
  nextCursor: string;
  newRecords: SessionMessage[];
  truncated: boolean;
  change?: FileChange;
};

export function sessionLocators(agent: SessionAgentId, root: string): SessionLocator[] {
  if (!isDirectory(root)) {
    return [];
  }
  switch (agent) {
    case "cursor":
      return cursorLocators(root);
    case "codex":
    case "claude_code":
      return jsonlLocators(root);
    default: {
      const unexpected: never = agent;
      throw new Error(`Unknown agent: ${unexpected}`);
    }
  }
}

export function discoverSessions(agent: SessionAgentId, root: string, changes: ChangeTracker | undefined): Discovered[] {
  const found: Discovered[] = [];
  for (const locator of sessionLocators(agent, root)) {
    pushChanged(found, changes, locator.files, () => readDiscovered(agent, locator));
  }
  return found;
}

function readDiscovered(agent: SessionAgentId, locator: SessionLocator): Discovered {
  switch (agent) {
    case "codex":
      return readJsonlSession("codex", locator.logFile, parseCodexText);
    case "claude_code":
      return readJsonlSession("claude_code", locator.logFile, parseClaudeCodeText);
    case "cursor":
      return readCursor(locator);
    default: {
      const unexpected: never = agent;
      throw new Error(`Unknown agent: ${unexpected}`);
    }
  }
}

function pushChanged(found: Discovered[], changes: ChangeTracker | undefined, paths: string[], read: () => Discovered): void {
  const change = changes?.changed(paths);
  if (change === null) {
    return;
  }
  const source = safely(read);
  if (!source) {
    // Unparseable files are tried again once they change.
    if (change) {
      changes?.remember(change);
    }
    return;
  }
  found.push(change ? { ...source, change } : source);
}

function safely(read: () => Discovered): Discovered | null {
  try {
    return read();
  } catch {
    return null;
  }
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
    byteOffset: "0",
    nextCursor: String(completeEnd),
    newRecords: parsed.records,
    truncated: false,
  };
}

function readCursor(locator: SessionLocator): Discovered {
  const transcript = readFileSync(locator.logFile);
  const generation = fileGeneration(locator.logFile);
  const completeEnd = completePrefixEnd(transcript);
  const sessionFile = locator.files.find((file) => file !== locator.logFile);
  let parsed = emptyParsed();
  try {
    parsed = parseCursorText(
      sessionFile === undefined ? "" : readFileSync(sessionFile, "utf8"),
      transcript.subarray(0, completeEnd).toString("utf8"),
    );
  } catch {
    parsed = emptyParsed();
  }
  return {
    agent: "cursor",
    sessionKey: parsed.sessionId ?? locator.key,
    locator: locator.key,
    parsed,
    generation,
    byteOffset: "0",
    nextCursor: String(completeEnd),
    newRecords: parsed.records,
    truncated: false,
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

function jsonlLocators(root: string): SessionLocator[] {
  return walkFiles(root, ".jsonl").map((filePath) => ({
    key: filePath,
    files: [filePath],
    logFile: filePath,
  }));
}

function cursorLocators(root: string): SessionLocator[] {
  const found: SessionLocator[] = [];
  for (const directory of walkDirectories(root)) {
    const sessionPath = join(directory, "session.json");
    const transcriptPath = join(directory, "transcript.jsonl");
    if (!exists(sessionPath) || !exists(transcriptPath)) {
      continue;
    }
    found.push({
      key: directory,
      files: [sessionPath, transcriptPath],
      logFile: transcriptPath,
    });
  }
  return found;
}

function isDirectory(root: string): boolean {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function exists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(root: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readEntries(root)) {
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
  for (const entry of readEntries(root)) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    found.push(...walkDirectories(join(root, entry.name)));
  }
  return found;
}
