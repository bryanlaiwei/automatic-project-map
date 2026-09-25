import { textFromContent } from "../redact.js";
import type { ParsedSession, SessionRecord } from "../types.js";
import { readJsonLines } from "./codex.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseClaudeCodeSession(filePath: string): ParsedSession {
  const lines = readJsonLines(filePath);
  let sessionId: string | null = null;
  let sourceVersion: string | null = null;
  let createdAt: string | null = null;
  const folders = new Set<string>();
  const records: SessionRecord[] = [];

  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") {
      continue;
    }
    sessionId = sessionId ?? asString(line.sessionId);
    sourceVersion = sourceVersion ?? asString(line.version);
    const folder = asString(line.cwd);
    if (folder) {
      folders.add(folder);
    }
    const occurredAt = asString(line.timestamp);
    if (occurredAt === null) {
      continue;
    }
    if (createdAt === null || Date.parse(occurredAt) < Date.parse(createdAt)) {
      createdAt = occurredAt;
    }
    const message = asRecord(line.message);
    const text = textFromContent(message?.content);
    const id = asString(line.uuid);
    if (id === null || text === "") {
      continue;
    }
    records.push({
      id,
      role: line.type,
      text,
      occurredAt,
    });
  }

  return {
    sessionId,
    createdAt,
    workingFolder: folders.size === 1 ? [...folders][0] ?? null : null,
    sourceVersion,
    records,
    ambiguousFolder: folders.size > 1,
  };
}
