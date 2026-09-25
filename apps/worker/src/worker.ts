import PgBoss from "pg-boss";
import type { Pool } from "pg";
import { refreshObservedGithub } from "@apm/api/github-refresh";
import { processQueuedDeliveries, type GithubLookup } from "@apm/api/store";

export type WorkerJob = {
  name: string;
  cron: string;
  run(): Promise<string>;
};

export type RunningWorker = {
  boss: PgBoss;
  stop(): Promise<void>;
};

export function backgroundJobs(input: { pool: Pool; github: GithubLookup }): WorkerJob[] {
  return [
    {
      name: "sweep-deliveries",
      cron: "* * * * *",
      async run() {
        const processed = await processQueuedDeliveries(input.pool, input.github, { olderThanSeconds: 60 });
        return `processed ${processed} stale queued deliveries`;
      },
    },
    {
      name: "refresh-github",
      cron: "*/5 * * * *",
      async run() {
        const result = await refreshObservedGithub(input.pool, input.github);
        return `checked ${result.checked} open GitHub items, stored ${result.eventsStored} updates`;
      },
    },
  ];
}

export async function startWorker(input: {
  connectionString: string;
  jobs: WorkerJob[];
  log?: (line: string) => void;
}): Promise<RunningWorker> {
  const log = input.log ?? console.log;
  const boss = new PgBoss({ connectionString: input.connectionString, max: 4 });
  boss.on("error", (error: Error) => log(`pg-boss error: ${error.message}`));
  await boss.start();

  for (const job of input.jobs) {
    if (!(await boss.getQueue(job.name))) {
      await boss.createQueue(job.name, { name: job.name, policy: "stately" });
    }
    await boss.schedule(job.name, job.cron);
    await boss.work(job.name, async () => {
      log(`${job.name}: ${await job.run()}`);
    });
  }
  for (const job of input.jobs) {
    await boss.send(job.name, {}, { singletonKey: job.name });
  }

  return {
    boss,
    async stop() {
      await boss.stop({ graceful: true, wait: true, timeout: 10_000 });
    },
  };
}
