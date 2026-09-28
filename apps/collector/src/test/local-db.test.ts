import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDb } from "../local-db.js";

const projectId = "33333333-3333-4333-8333-333333333333";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";
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

function paired(db: LocalDb, deviceId = "device-1"): void {
  db.savePairing({ projectId, trackingStartedAt, apiUrl: "http://127.0.0.1:1", deviceToken: "apm_device", deviceId });
}

describe("pairing", () => {
  it("replaces the previous pairing when the helper is connected to another project", () => {
    const db = new LocalDb(join(tempRoot(), "collector.sqlite"));
    paired(db);
    const otherProject = "44444444-4444-4444-8444-444444444444";
    db.savePairing({ projectId: otherProject, trackingStartedAt, apiUrl: "http://127.0.0.1:1", deviceToken: "apm_other", deviceId: "device-other" });
    expect(db.getPairing()).toMatchObject({ projectId: otherProject, deviceToken: "apm_other", deviceId: "device-other" });
    expect(db.db.prepare("select count(*) as count from pairing").get()).toEqual({ count: 1 });
    db.close();
  });
});
