// Reads the bytes of a session log that come after the saved checkpoint.
// The checkpoint is the byte offset stored in the next_cursor column.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeCodeText } from "./adapters/claude-code.js";
import { parseCodexText } from "./adapters/codex.js";
import { parseCursorText } from "./adapters/cursor.js";
import type { SessionAgentId } from "./contract/adapter.js";
import type { ParsedSession } from "./contract/session.js";
import type { Discovered } from "./find-sessions.js";
import { completePrefixEnd } from "./log-bytes.js";

export function sliceNewRecords(source: Discovered, savedOffset: string): Discovered {
  const offset = savedOffset === "" ? 0 : Number(savedOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ...source, truncated: true, newRecords: [], byteOffset: savedOffset };
  }
  if (offset === 0) {
    return { ...source, byteOffset: "" };
  }
  const filePath = source.agent === "cursor" ? join(source.locator, "transcript.jsonl") : source.locator;
  const bytes = readFileSync(filePath);
  const completeEnd = completePrefixEnd(bytes);
  // The saved offset always sat just after a newline, so a file that no longer has one there was rewritten.
  if (bytes.length < offset || offset > completeEnd) {
    return { ...source, truncated: true, newRecords: [], byteOffset: savedOffset };
  }
  const newText = bytes.subarray(offset, completeEnd).toString("utf8");
  const parsedNew = parseOffset(source.agent, source.locator, newText);
  return {
    ...source,
    byteOffset: savedOffset,
    nextCursor: String(completeEnd),
    newRecords: parsedNew.records,
  };
}

function parseOffset(agent: SessionAgentId, locator: string, newText: string): ParsedSession {
  switch (agent) {
    case "codex":
      return parseCodexText(newText);
    case "claude_code":
      return parseClaudeCodeText(newText);
    case "cursor":
      return parseCursorText(readFileSync(join(locator, "session.json"), "utf8"), newText);
    default: {
      const unexpected: never = agent;
      throw new Error(`Unknown agent: ${unexpected}`);
    }
  }
}
