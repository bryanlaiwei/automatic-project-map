// Reads Cursor sessions and turns them into the same messages the other agents upload.
// A hook export is session.json plus transcript.jsonl. Cursor's own agent log is
// <project-slug>/agent-transcripts/<id>/<id>.jsonl under ~/.cursor/projects.

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentAdapter, SessionLocator } from "../contract/adapter.js";
import type { ParsedSession, SessionRecord } from "../contract/session.js";
import { isDirectory, isFile, walkDirectories, walkFiles } from "../log-walk.js";
import { textFromContent } from "../message-text.js";
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

export function parseCursorSession(directoryPath: string): ParsedSession {
  const metaText = readFileSync(join(directoryPath, "session.json"), "utf8");
  const transcript = readFileSync(join(directoryPath, "transcript.jsonl"), "utf8");
  return parseCursorText(metaText, transcript);
}

export function parseCursorText(metaText: string, transcript: string): ParsedSession {
  const meta = asRecord(JSON.parse(metaText) as unknown);
  return cursorMessages(asString(meta?.session_id), asString(meta?.created_at), asString(meta?.cwd), asString(meta?.cursor_version), transcript);
}

/** Restores the working folder from Cursor's project directory name. More than one existing path is ambiguous. */
export function cursorWorkingFolders(slug: string): string[] {
  const tokens = slug.split("-").filter((token) => token.length > 0);
  const found: string[] = [];
  const visit = (index: number, directory: string): void => {
    if (found.length > 1) {
      return;
    }
    if (index === tokens.length) {
      found.push(directory);
      return;
    }
    let name = "";
    for (let end = index; end < tokens.length; end += 1) {
      const token = tokens[end] ?? "";
      name = name === "" ? token : `${name}-${token}`;
      const next = join(directory, name);
      if (isDirectory(next)) {
        visit(end + 1, next);
      }
    }
  };
  visit(0, "/");
  return found;
}

function cursorMessages(
  sessionId: string | null,
  createdAt: string | null,
  workingFolder: string | null,
  sourceVersion: string | null,
  transcript: string,
  ambiguousFolder = false,
): ParsedSession {
  const records: SessionRecord[] = [];
  for (const [index, line] of parseJsonLines(transcript).entries()) {
    const role = line.role === "assistant" ? "assistant" : line.role === "user" ? "user" : null;
    if (role === null) {
      continue;
    }
    const message = asRecord(line.message);
    const text = textFromContent(message?.content);
    if (text === "" || createdAt === null) {
      continue;
    }
    records.push({ id: String(index), role, text, occurredAt: createdAt });
  }
  return { sessionId, createdAt, workingFolder, sourceVersion, records, ambiguousFolder };
}

function hookLocators(root: string): SessionLocator[] {
  const found: SessionLocator[] = [];
  for (const directory of walkDirectories(root)) {
    const sessionPath = join(directory, "session.json");
    const transcriptPath = join(directory, "transcript.jsonl");
    if (!isFile(sessionPath) || !isFile(transcriptPath)) {
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

function nativeLocators(root: string): SessionLocator[] {
  if (!isDirectory(root)) {
    return [];
  }
  const found: SessionLocator[] = [];
  for (const filePath of walkFiles(root, ".jsonl")) {
    if (basename(filePath) === "transcript.jsonl") {
      continue;
    }
    const sessionDir = dirname(filePath);
    const sessionId = basename(filePath, ".jsonl");
    if (basename(sessionDir) !== sessionId || basename(dirname(sessionDir)) !== "agent-transcripts") {
      continue;
    }
    found.push({ key: filePath, files: [filePath], logFile: filePath });
  }
  return found;
}

function scanRoot(root: string): string {
  const projects = join(root, "projects");
  return isDirectory(projects) ? projects : root;
}

function fileCreatedAt(filePath: string): string | null {
  try {
    const created = statSync(filePath).birthtime;
    if (Number.isNaN(created.getTime()) || created.getTime() <= 0) {
      return null;
    }
    return created.toISOString();
  } catch {
    return null;
  }
}

function parseNativeTranscript(filePath: string, transcript: string): ParsedSession {
  const sessionId = basename(filePath, ".jsonl");
  const slug = basename(dirname(dirname(dirname(filePath))));
  const folders = cursorWorkingFolders(slug);
  const workingFolder = folders.length === 1 ? folders[0] ?? null : null;
  return cursorMessages(sessionId, fileCreatedAt(filePath), workingFolder, null, transcript, folders.length > 1);
}

function emptyCursorSession(): ParsedSession {
  return {
    sessionId: null,
    createdAt: null,
    workingFolder: null,
    sourceVersion: null,
    records: [],
    ambiguousFolder: false,
  };
}

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  logDirectory(env, home) {
    return env.APM_CURSOR_SESSIONS?.trim() || join(home, ".cursor");
  },
  discover(root) {
    const scan = scanRoot(root);
    return [...hookLocators(scan), ...nativeLocators(scan)];
  },
  read(locator, logBytes) {
    const sessionFile = locator.files.find((file) => basename(file) === "session.json");
    try {
      if (sessionFile !== undefined) {
        return parseCursorText(readFileSync(sessionFile, "utf8"), logBytes.toString("utf8"));
      }
      return parseNativeTranscript(locator.logFile, logBytes.toString("utf8"));
    } catch {
      return emptyCursorSession();
    }
  },
  readPath(filePath) {
    if (basename(filePath).endsWith(".jsonl")) {
      return parseNativeTranscript(filePath, readFileSync(filePath, "utf8"));
    }
    return parseCursorSession(filePath);
  },
};
