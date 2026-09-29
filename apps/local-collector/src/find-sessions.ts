// Finds session files under an agent's log directory and reads the ones the change tracker has not already seen.
// Each result is the parsed session and the byte offset of its last complete line.

import { readFileSync } from "node:fs";
import type { SessionMessage } from "@apm/shared";
import type { ChangeTracker, FileChange } from "./change-tracker.js";
import type { AgentAdapter, SessionLocator } from "./contract/adapter.js";
import type { ParsedSession } from "./contract/session.js";
import { completePrefixEnd, fileGeneration } from "./log-bytes.js";

export type Discovered = {
  agent: AgentAdapter["id"];
  sessionKey: string;
  locator: SessionLocator;
  parsed: ParsedSession;
  generation: string;
  byteOffset: string;
  nextCursor: string;
  newRecords: SessionMessage[];
  truncated: boolean;
  change?: FileChange;
};

export function discoverSessions(adapter: AgentAdapter, root: string, changes: ChangeTracker | undefined): Discovered[] {
  const found: Discovered[] = [];
  for (const locator of adapter.discover(root)) {
    pushChanged(found, changes, locator.files, () => readDiscovered(adapter, locator));
  }
  return found;
}

function readDiscovered(adapter: AgentAdapter, locator: SessionLocator): Discovered {
  const bytes = readFileSync(locator.logFile);
  const generation = fileGeneration(locator.logFile);
  const completeEnd = completePrefixEnd(bytes);
  const completeBytes = bytes.subarray(0, completeEnd);
  const parsed = completeBytes.length === 0 ? emptyParsed() : adapter.read(locator, completeBytes);
  return {
    agent: adapter.id,
    sessionKey: parsed.sessionId ?? locator.key,
    locator,
    parsed,
    generation,
    byteOffset: "0",
    nextCursor: String(completeEnd),
    newRecords: parsed.records,
    truncated: false,
  };
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
