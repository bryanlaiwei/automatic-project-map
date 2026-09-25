import { statSync } from "node:fs";

/**
 * Remembers each log file's size and modification time so a scan can skip
 * files that have not changed since they were last read.
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

  /** Returns true when the files look the same as last time, and records them otherwise. */
  unchanged(paths: readonly string[]): boolean {
    const key = paths.join("\u0000");
    const signature = paths.map(fileSignature).join("|");
    if (this.seen.get(key) === signature) {
      return true;
    }
    this.seen.set(key, signature);
    return false;
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
