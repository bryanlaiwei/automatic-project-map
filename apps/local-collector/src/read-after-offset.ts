// Reads the bytes of a session log that come after the saved checkpoint.
// The checkpoint is the byte offset stored in the next_cursor column.

import { readFileSync } from "node:fs";
import type { AgentAdapter } from "./contract/adapter.js";
import type { Discovered } from "./find-sessions.js";
import { completePrefixEnd } from "./log-bytes.js";

export function sliceNewRecords(adapter: AgentAdapter, source: Discovered, savedOffset: string): Discovered {
  const offset = savedOffset === "" ? 0 : Number(savedOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ...source, truncated: true, newRecords: [], byteOffset: savedOffset };
  }
  if (offset === 0) {
    return { ...source, byteOffset: "" };
  }
  const bytes = readFileSync(source.locator.logFile);
  const completeEnd = completePrefixEnd(bytes);
  // The saved offset always sat just after a newline, so a file that no longer has one there was rewritten.
  if (bytes.length < offset || offset > completeEnd) {
    return { ...source, truncated: true, newRecords: [], byteOffset: savedOffset };
  }
  const parsedNew = adapter.read(source.locator, bytes.subarray(offset, completeEnd));
  return {
    ...source,
    byteOffset: savedOffset,
    nextCursor: String(completeEnd),
    newRecords: parsedNew.records,
  };
}
