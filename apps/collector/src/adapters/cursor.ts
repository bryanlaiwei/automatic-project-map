import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export function parseCursorSession(directoryPath: string): ParsedSession {
  const meta = asRecord(JSON.parse(readFileSync(join(directoryPath, "session.json"), "utf8")));
  const lines = readJsonLines(join(directoryPath, "transcript.jsonl"));
  const records: SessionRecord[] = [];

  for (const [index, line] of lines.entries()) {
    const role = line.role === "assistant" ? "assistant" : line.role === "user" ? "user" : null;
    if (role === null) {
      continue;
    }
    const message = asRecord(line.message);
    const text = textFromContent(message?.content);
    if (text === "") {
      continue;
    }
    const createdAt = asString(meta?.created_at);
    records.push({
      id: String(index),
      role,
      text,
      occurredAt: createdAt ?? "",
    });
  }

  return {
    sessionId: asString(meta?.session_id),
    createdAt: asString(meta?.created_at),
    workingFolder: asString(meta?.cwd),
    sourceVersion: asString(meta?.cursor_version),
    records: records.filter((record) => record.occurredAt !== ""),
    ambiguousFolder: false,
  };
}
