import { loadEnvFile } from "@apm/api/env";
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
});
