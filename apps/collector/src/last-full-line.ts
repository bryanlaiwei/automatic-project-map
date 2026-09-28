// Two questions about a log file: is this the same file as last time, and where does the last full line end.
// A line that is still being written is skipped until it gets a newline.

import { statSync } from "node:fs";

export function fileGeneration(filePath: string): string {
  const stat = statSync(filePath);
  return `${stat.dev}:${stat.ino}`;
}

/** Byte offset just past the last complete line. A trailing partial line is left unread. */
export function completePrefixEnd(bytes: Buffer): number {
  return bytes.lastIndexOf(0x0a) + 1;
}
