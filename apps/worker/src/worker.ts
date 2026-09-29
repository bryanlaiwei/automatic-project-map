import PgBoss from "pg-boss";
import type { Pool } from "pg";
import { dueProjects, processProject, type Interpreter, type ProcessResult } from "@apm/api/graph/process";
import { insertEvents, processQueuedDeliveries } from "@apm/api/store";
import type { GithubLookup } from "@apm/github-collector/enrich";
import { refreshObservedGithub } from "@apm/github-collector/refresh";

export type WorkerJob = {
  name: string;
  cron: string;
  run(): Promise<string>;
};

export type RunningWorker = {
  boss: PgBoss;
  /** Finds projects with work due and queues them; the worker also does this on a timer. */
  dispatch(): Promise<number>;
  stop(): Promise<void>;
};

export type ProjectProcessing = {
  pool: Pool;
  interpreter: Interpreter | null;
  dispatchEveryMs?: number;
  concurrency?: number;
};

export const processProjectQueue = "process-project";
const defaultProjectConcurrency = 3;

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
        const result = await refreshObservedGithub(input.pool, input.github, {
          writeEvents: (events) => insertEvents(input.pool, events),
        });
        return `checked ${result.checked} open GitHub items, stored ${result.eventsStored} updates`;
      },
    },
  ];
}

export async function startWorker(input: {
  connectionString: string;
  jobs: WorkerJob[];
  processing?: ProjectProcessing;
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

  const processing = input.processing;
  let dispatch = async () => 0;
  let timer: NodeJS.Timeout | null = null;
  if (processing) {
    if (!(await boss.getQueue(processProjectQueue))) {
      await boss.createQueue(processProjectQueue, { name: processProjectQueue, policy: "stately" });
    }
    // Each project has at most one active job (stately, keyed by project), so these workers only run
    // different projects side by side; one project's model calls do not hold up another's facts.
    for (let slot = 0; slot < (processing.concurrency ?? defaultProjectConcurrency); slot += 1) {
      await boss.work<{ projectId: string }>(processProjectQueue, { pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const result = await processProject(processing.pool, job.data.projectId, { interpreter: processing.interpreter, log });
          const summary = describeProcessing(result);
          if (summary) {
            log(`${processProjectQueue} ${job.data.projectId}: ${summary}`);
          }
        }
      });
    }
    dispatch = async () => {
      const projects = await dueProjects(processing.pool, { includeInterpretation: processing.interpreter !== null });
      for (const projectId of projects) {
        await boss.send(processProjectQueue, { projectId }, { singletonKey: projectId });
      }
      return projects.length;
    };
    let dispatching = false;
    timer = setInterval(() => {
      if (dispatching) {
        return;
      }
      dispatching = true;
      dispatch()
        .catch((error: unknown) => log(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          dispatching = false;
        });
    }, processing.dispatchEveryMs ?? 5_000);
  }

  return {
    boss,
    dispatch,
    async stop() {
      if (timer) {
        clearInterval(timer);
      }
      await boss.stop({ graceful: true, wait: true, timeout: 10_000 });
    },
  };
}

export function describeProcessing(result: ProcessResult): string | null {
  const parts: string[] = [];
  const applied = result.facts.reduce((sum, batch) => sum + batch.applied, 0);
  const invalid = result.facts.reduce((sum, batch) => sum + batch.invalid, 0);
  if (applied + invalid > 0) {
    parts.push(`applied ${applied} factual events${invalid > 0 ? `, ${invalid} invalid` : ""}`);
  }
  for (const outcome of result.interpretations) {
    switch (outcome.status) {
      case "applied":
        parts.push(`interpreted ${outcome.evidence} evidence into revision ${outcome.revision ?? "?"}`);
        break;
      case "no_change":
        parts.push(`${outcome.evidence} evidence changed nothing`);
        break;
      case "superseded":
        parts.push(`discarded a proposal overtaken by a correction`);
        break;
      case "failed":
        parts.push(`interpretation failed: ${outcome.error}`);
        break;
      default: {
        const unhandled: never = outcome;
        throw new Error(`Unhandled interpretation outcome ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
