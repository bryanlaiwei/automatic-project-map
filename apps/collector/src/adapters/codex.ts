import { readFileSync } from "node:fs";
import { textFromContent } from "../redact.js";
import type { ParsedSession, SessionRecord } from "../types.js";

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

export function readJsonLines(filePath: string): JsonRecord[] {
  const text = readFileSync(filePath, "utf8");
  const records: JsonRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const parsed: unknown = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export function parseCodexSession(filePath: string): ParsedSession {
  const lines = readJsonLines(filePath);
  let sessionId: string | null = null;
  let createdAt: string | null = null;
  let workingFolder: string | null = null;
  let sourceVersion: string | null = null;
  const records: SessionRecord[] = [];

  for (const [index, line] of lines.entries()) {
    const payload = asRecord(line.payload);
    if (line.type === "session_meta" && payload) {
      sessionId = asString(payload.id) ?? asString(payload.session_id);
      createdAt = asString(payload.timestamp);
      workingFolder = asString(payload.cwd);
      sourceVersion = asString(payload.cli_version);
      continue;
    }

    const occurredAt = asString(line.timestamp);
    const recordId = asString(line.ordinal) ?? String(index);
    if (!payload || occurredAt === null) {
      continue;
    }

    if (line.type === "event_msg" && payload.type === "user_message") {
      const text = textFromContent(payload.message);
      if (text !== "") {
        records.push({ id: recordId, role: "user", text, occurredAt });
      }
      continue;
    }

    if (line.type === "response_item" && payload.type === "message") {
      const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
      if (role === null) {
        continue;
      }
      const text = textFromContent(payload.content);
      if (text !== "") {
        records.push({ id: recordId, role, text, occurredAt });
      }
    }
  }

  return {
    sessionId,
    createdAt,
    workingFolder,
    sourceVersion,
    records,
    ambiguousFolder: false,
  };
}
