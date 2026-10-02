import { getPool } from "@apm/api/db";
import { loadEnvFile } from "@apm/api/env";
import { createGithubEnricher } from "@apm/github-collector/enrich";
import { openAiInterpreterFromEnv } from "@apm/api/graph/openai-interpreter";
import { resolveProjectInterpreter } from "@apm/api/model-credentials";
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
const fallback = openAiInterpreterFromEnv();
const worker = await startWorker({
  connectionString,
  jobs: backgroundJobs({ pool, github }),
  deliveries: { pool, github },
  processing: {
    pool,
    resolveInterpreter: (projectId) => resolveProjectInterpreter(pool, projectId),
    interpretation: fallback ? "all" : "owner-key",
  },
});
console.log("worker running: webhook deliveries as they arrive, stale deliveries every minute, GitHub refresh every 5 minutes, project processing every 5 seconds");
console.log(
  fallback
    ? `map interpretation uses each project owner's saved model key, or OpenAI model ${fallback.model} when an owner has not saved one`
    : "no server OpenAI key: map interpretation runs for projects whose owner has saved an OpenAI, Anthropic, or Gemini key",
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
