import { statSync } from "node:fs";

export function fileGeneration(filePath: string): string {
  const stat = statSync(filePath);
  return `${stat.dev}:${stat.ino}`;
}

/** Byte offset just past the last complete line. A trailing partial line is left unread. */
export function completePrefixEnd(bytes: Buffer): number {
  const text = bytes.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    return 0;
  }
  return Buffer.byteLength(text.slice(0, lastNewline + 1));
}
