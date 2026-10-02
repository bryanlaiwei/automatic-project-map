import { assertConfig } from "@apm/core/config";
import { createGithubEnricher } from "@apm/github-collector/enrich";

let settings: ReturnType<typeof assertConfig>;
try {
  settings = assertConfig("worker");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker configuration is invalid.");
  process.exit(1);
}

const { getPool } = await import("@apm/core/db");
const { openAiInterpreterFromEnv } = await import("@apm/core/graph/openai-interpreter");
const { resolveProjectInterpreter } = await import("@apm/core/model-credentials");
const { backgroundJobs, startWorker } = await import("./worker.js");

const pool = getPool();
const github = createGithubEnricher({
  appId: settings.githubAppId,
  privateKey: settings.githubAppPrivateKey,
});
const fallback = openAiInterpreterFromEnv();
const worker = await startWorker({
  connectionString: settings.databaseUrl,
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
