import { getPool } from "@apm/api/db";
import { loadEnvFile } from "@apm/api/env";
import { connectRepository, insertEvents } from "@apm/api/store";
import { SCHEMA_VERSION } from "@apm/shared";
import { describe, expect, it } from "vitest";
import { startWorker, type WorkerJob } from "./worker.js";

loadEnvFile();

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the worker.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("worker", () => {
  it("schedules each job, runs it once at start, and restarts cleanly", async () => {
    const connectionString = process.env.DATABASE_URL ?? "";
    const ran: string[] = [];
    const jobs: WorkerJob[] = ["test-worker-a", "test-worker-b"].map((name) => ({
      name,
      cron: "0 0 1 1 *",
      async run() {
        ran.push(name);
        return "ok";
      },
    }));

    const first = await startWorker({ connectionString, jobs, log: () => undefined });
    try {
      await waitFor(() => ran.length >= 2, 20_000);
      expect([...ran].sort()).toEqual(["test-worker-a", "test-worker-b"]);
      const schedules = await first.boss.getSchedules();
      expect(schedules.map((schedule) => schedule.name)).toEqual(expect.arrayContaining(["test-worker-a", "test-worker-b"]));
    } finally {
      await first.stop();
    }

    const second = await startWorker({ connectionString, jobs, log: () => undefined });
    try {
      await waitFor(() => ran.length >= 4, 20_000);
    } finally {
      for (const job of jobs) {
        await second.boss.unschedule(job.name);
      }
      await second.stop();
    }
  }, 60_000);

  it("queues projects with new facts and applies them without an AI key", async () => {
    const connectionString = process.env.DATABASE_URL ?? "";
    const pool = getPool();
    const workspace = "worker/processing";
    await pool.query("delete from workspaces where name = $1", [workspace]);
    const connected = await connectRepository(pool, {
      userId: "a0000000-0000-4000-8000-000000000001",
      owner: "worker",
      name: "processing",
      repoId: 88_004_001,
    });
    if (!("project" in connected)) {
      throw new Error(`Could not connect test project: ${connected.error}`);
    }
    const projectId = connected.project.id;
    const updatedAt = new Date().toISOString();
    await insertEvents(pool, [
      {
        schemaVersion: SCHEMA_VERSION,
        eventId: `github:test:worker-pr:${updatedAt}`,
        sourceKey: "github:pull_request:4001",
        projectId,
        source: "github",
        occurredAt: updatedAt,
        details: {
          kind: "pr.updated",
          repositoryId: 88_004_001,
          pullRequestId: 4001,
          number: 1,
          title: "Worker test",
          body: "",
          url: "https://github.com/worker/processing/pull/1",
          draft: false,
          state: "open",
          merged: false,
          headSha: "abc1234",
          updatedAt,
        },
      },
    ]);

    const lines: string[] = [];
    const worker = await startWorker({
      connectionString,
      jobs: [],
      processing: { pool, interpreter: null, dispatchEveryMs: 60_000 },
      log: (line) => lines.push(line),
    });
    try {
      expect(await worker.dispatch()).toBeGreaterThanOrEqual(1);
      await waitFor(() => lines.some((line) => line.includes(projectId)), 20_000);
      const facts = await pool.query<{ facts_state: string }>(`select facts_state from normalized_events where project_id = $1`, [projectId]);
      expect(facts.rows).toEqual([{ facts_state: "applied" }]);
      const evidence = await pool.query<{ interpretation_state: string }>(
        `select interpretation_state from evidence where project_id = $1`,
        [projectId],
      );
      expect(evidence.rows).toEqual([{ interpretation_state: "pending" }]);
    } finally {
      await worker.stop();
      await pool.query("delete from workspaces where name = $1", [workspace]);
      await pool.end();
    }
  }, 60_000);
});
