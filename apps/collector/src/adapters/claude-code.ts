// Reads Claude Code session jsonl files and turns them into messages.
// The adapter object is the contract the scan can call; parseClaudeCodeText stays the function the scan calls today.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../contract/adapter.js";
import type { ParsedSession, SessionRecord } from "../contract/types.js";
import { sessionLocators } from "../discover.js";
import { textFromContent } from "../redact.js";
import { parseJsonLines } from "./codex.js";

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
  return parseClaudeCodeText(readFileSync(filePath, "utf8"));
}

export function parseClaudeCodeText(text: string): ParsedSession {
  const lines = parseJsonLines(text);
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

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude_code",
  logDirectory(env, home) {
    return env.APM_CLAUDE_PROJECTS?.trim() || join(home, ".claude", "projects");
  },
  discover(root) {
    return sessionLocators("claude_code", root);
  },
  read(_locator, logBytes) {
    return parseClaudeCodeText(logBytes.toString("utf8"));
  },
};
