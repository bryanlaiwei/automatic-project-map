// Byte helpers for a growing log: which file identity a checkpoint belongs to, and where the last complete line ends.
// A trailing partial line is left unread until the agent writes its newline.

import { statSync } from "node:fs";

export function fileGeneration(filePath: string): string {
  const stat = statSync(filePath);
  return `${stat.dev}:${stat.ino}`;
}

/** Byte offset just past the last complete line. A trailing partial line is left unread. */
export function completePrefixEnd(bytes: Buffer): number {
  return bytes.lastIndexOf(0x0a) + 1;
}
