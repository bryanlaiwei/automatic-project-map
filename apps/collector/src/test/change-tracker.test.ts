import { appendFileSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker } from "../change-tracker.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apm-loop-")));
  temps.push(root);
  return root;
}

describe("change tracker", () => {
  function seenAfterCheck(tracker: ChangeTracker, file: string): boolean {
    const change = tracker.changed([file]);
    if (change) {
      tracker.remember(change);
    }
    return change === null;
  }

  it("skips a file until its size or modification time changes, and forgets on a new scope", () => {
    const root = tempRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "one\n");
    const tracker = new ChangeTracker();
    tracker.useScope("project-a");
    expect(seenAfterCheck(tracker, file)).toBe(false);
    expect(seenAfterCheck(tracker, file)).toBe(true);
    appendFileSync(file, "two\n");
    expect(seenAfterCheck(tracker, file)).toBe(false);
    utimesSync(file, new Date("2026-09-25T00:00:00Z"), new Date("2026-09-25T00:00:00Z"));
    expect(seenAfterCheck(tracker, file)).toBe(false);
    expect(seenAfterCheck(tracker, file)).toBe(true);
    tracker.useScope("project-a");
    expect(seenAfterCheck(tracker, file)).toBe(true);
    tracker.useScope("project-a with another folder");
    expect(seenAfterCheck(tracker, file)).toBe(false);
  });

  it("keeps offering a file until it is remembered", () => {
    const root = tempRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "one\n");
    const tracker = new ChangeTracker();
    expect(tracker.changed([file])).not.toBeNull();
    expect(tracker.changed([file])).not.toBeNull();
  });
});
