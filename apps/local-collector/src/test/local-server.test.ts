import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorLoop } from "../collector-loop.js";
import { LocalDb } from "../local-db.js";
import { startLocalServer } from "../local-server.js";

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

describe("local helper api", () => {
  async function startHelper(root: string) {
    const db = new LocalDb(join(root, "collector.sqlite"));
    let scans = 0;
    const loop = new CollectorLoop({ db, logRoots: { codex: join(root, "codex") } });
    const server = await startLocalServer({
      db,
      port: 0,
      webOrigin: "http://127.0.0.1:5173",
      logRoots: { codex: join(root, "codex") },
      status: () => loop.status(),
      scanNow: async () => {
        scans += 1;
        return loop.tick();
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ token: "apm_device", deviceId: "device-web", projectId, trackingStartedAt }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const port = (server.address() as AddressInfo).port;
    return { db, server, base: `http://127.0.0.1:${port}`, port, scans: () => scans };
  }

  it("pairs from the web app, then lets a person on this computer choose folders", async () => {
    const root = tempRoot();
    const helper = await startHelper(root);

    const preflight = await fetch(`${helper.base}/pair`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    const pair = await fetch(`${helper.base}/pair`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "web-code", apiUrl: "http://127.0.0.1:4000" }),
    });
    expect(pair.status).toBe(201);
    expect(pair.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(helper.db.getPairing()?.deviceId).toBe("device-web");

    const outside = await fetch(`${helper.base}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(outside.status).toBe(401);

    const visit = await fetch(helper.base, { headers: { Origin: "http://127.0.0.1:5173" } });
    const overview = (await visit.json()) as { pairing: { projectId: string }; logRoots: Array<{ path: string }> };
    expect(visit.headers.get("content-type")).toContain("application/json");
    expect(overview.pairing.projectId).toBe(projectId);
    expect(overview.logRoots.map((rootEntry) => rootEntry.path)).toContain(join(root, "codex"));

    const added = await fetch(`${helper.base}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ path: root }),
    });
    expect(added.status).toBe(201);
    expect(helper.db.folders().map((folder) => folder.canonicalPath)).toEqual([root]);
    expect(helper.scans()).toBeGreaterThanOrEqual(2);

    const status = (await (await fetch(`${helper.base}/status`)).json()) as { status: { paired: boolean } };
    expect(status.status.paired).toBe(true);
    helper.server.close();
    helper.db.close();
  });

  it("refuses a request that names another host, so a rebound DNS name cannot reach it", async () => {
    const helper = await startHelper(tempRoot());
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: helper.port, path: "/", headers: { Host: `attacker.example:${helper.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    helper.server.close();
    helper.db.close();
  });
});

function openDb(root: string): LocalDb {
  return new LocalDb(join(root, "collector.sqlite"));
}

describe("local helper", () => {
  it("pairs from the web app and rejects another origin", async () => {
    const root = tempRoot();
    const db = openDb(root);
    let paired = false;
    const server = await startLocalServer({
      db,
      port: 0,
      webOrigin: "http://127.0.0.1:5173",
      fetchImpl: async () => {
        paired = true;
        return new Response(
          JSON.stringify({
            token: "apm_test",
            deviceId: "device-1",
            projectId,
            trackingStartedAt,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("helper did not bind");
    }
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    const overview = (await page.json()) as { pairing: null };
    expect(overview.pairing).toBeNull();
    const denied = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(denied.status).toBe(403);
    expect(paired).toBe(false);
    const accepted = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc", apiUrl: "http://127.0.0.1:4000" }),
    });
    expect(accepted.status).toBe(201);
    expect(db.getPairing()?.projectId).toBe(projectId);
    expect(db.getPairing()?.deviceToken).toBe("apm_test");
    server.close();
    db.close();
  });
});
