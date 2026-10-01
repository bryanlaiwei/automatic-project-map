// Reads Codex session jsonl files and turns them into messages.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../contract/adapter.js";
import type { ParsedSession, SessionRecord } from "../contract/session.js";
import { jsonlSessionLocators } from "../log-walk.js";
import { textFromContent } from "../message-text.js";

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

export function parseJsonLines(text: string): JsonRecord[] {
  if (text === "") {
    return [];
  }
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) {
    lines.pop();
  }
  const records: JsonRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const isLast = index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      if (isLast && !endsWithNewline) {
        continue;
      }
      throw error;
    }
    const record = asRecord(parsed);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export function parseCodexSession(filePath: string): ParsedSession {
  return parseCodexText(readFileSync(filePath, "utf8"));
}

export function parseCodexText(text: string): ParsedSession {
  const lines = parseJsonLines(text);
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

export const codexAdapter: AgentAdapter = {
  id: "codex",
  logDirectory(env, home) {
    return env.APM_CODEX_SESSIONS?.trim() || join(home, ".codex", "sessions");
  },
  discover(root) {
    return jsonlSessionLocators(root);
  },
  read(_locator, logBytes) {
    return parseCodexText(logBytes.toString("utf8"));
  },
  readPath(filePath) {
    return parseCodexSession(filePath);
  },
};
