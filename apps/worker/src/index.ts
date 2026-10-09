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
const { releaseHeldInterpretationLocks } = await import("@apm/core/graph/process");
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
    // resolveProjectInterpreter prefers a saved personal key. This release always uses the server OpenAI key.
    resolveInterpreter: async () => fallback,
    interpretation: fallback ? "all" : "none",
  },
});
console.log("worker running: webhook deliveries as they arrive, stale deliveries every minute, GitHub refresh every 5 minutes, project processing every 5 seconds");
console.log(
  fallback
    ? `map interpretation uses the server OpenAI model ${fallback.model}`
    : "no server OpenAI key: map interpretation is off until OPENAI_API_KEY is set",
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await worker.stop();
    await releaseHeldInterpretationLocks(pool);
    await pool.end();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Worker shutdown failed.");
    process.exit(1);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
