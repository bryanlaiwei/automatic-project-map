import { getPool } from "@apm/api/db";
import { loadEnvFile } from "@apm/api/env";
import { createGithubEnricher } from "@apm/api/github-enrich";
import { openAiInterpreterFromEnv } from "@apm/api/graph/openai-interpreter";
import { backgroundJobs, startWorker } from "./worker.js";

loadEnvFile();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const pool = getPool();
const github = createGithubEnricher({
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
});
const interpreter = openAiInterpreterFromEnv();
const worker = await startWorker({
  connectionString,
  jobs: backgroundJobs({ pool, github }),
  processing: { pool, interpreter },
});
console.log("worker running: stale deliveries every minute, GitHub refresh every 5 minutes, project processing every 5 seconds");
console.log(
  interpreter
    ? `map interpretation uses OpenAI model ${interpreter.model}`
    : "OPENAI_API_KEY is not set: GitHub and session facts still apply, but new evidence waits unread until a key is configured",
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
