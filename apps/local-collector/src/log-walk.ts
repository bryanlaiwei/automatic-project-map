// Walks a log directory. Adapters use this to build session locators. The scan does not name agents here.

import { readdirSync, statSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { SessionLocator } from "./contract/adapter.js";

export function isDirectory(root: string): boolean {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function walkFiles(root: string, extension: string): string[] {
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
    if (entry.isFile() && entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

export function walkDirectories(root: string): string[] {
  const found = [root];
  for (const entry of readEntries(root)) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    found.push(...walkDirectories(join(root, entry.name)));
  }
  return found;
}

/** One .jsonl file per session. Skips Cursor transcript files that sit beside session.json. */
export function jsonlSessionLocators(root: string): SessionLocator[] {
  if (!isDirectory(root)) {
    return [];
  }
  return walkFiles(root, ".jsonl")
    .filter((filePath) => basename(filePath) !== "transcript.jsonl")
    .map((filePath) => ({
      key: filePath,
      files: [filePath],
      logFile: filePath,
    }));
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
