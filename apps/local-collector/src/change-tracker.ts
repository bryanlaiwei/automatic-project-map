// Remembers each log file's size and modification time so a scan can skip sessions that have not changed.
// The remembered set is cleared when the paired project or the selected folders change.

import { statSync } from "node:fs";

export type FileChange = {
  key: string;
  signature: string;
};

/**
 * Remembers each log file's size and modification time so a scan can skip
 * files that have not changed since they were last collected.
 */
export class ChangeTracker {
  private readonly seen = new Map<string, string>();
  private scope = "";

  /** Forgets every file when the paired project or the selected folders change. */
  useScope(scope: string): void {
    if (scope !== this.scope) {
      this.seen.clear();
      this.scope = scope;
    }
  }

  /** Forgets every file, so the next scan reads them all again. */
  forget(): void {
    this.seen.clear();
  }

  /** Returns null when the files look the same as when they were last remembered. */
  changed(paths: readonly string[]): FileChange | null {
    const key = paths.join("\u0000");
    const signature = paths.map(fileSignature).join("|");
    return this.seen.get(key) === signature ? null : { key, signature };
  }

  /** Call only after the files were fully handled, so a failed read is tried again next scan. */
  remember(change: FileChange): void {
    this.seen.set(change.key, change.signature);
  }
}

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}
