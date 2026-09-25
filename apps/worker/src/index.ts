import { loadEnvFile } from "@apm/api/env";

loadEnvFile();

const { getPool } = await import("@apm/api/db");
const { createGithubEnricher } = await import("@apm/api/github-enrich");
const { processQueuedDeliveries } = await import("@apm/api/store");

const processed = await processQueuedDeliveries(
  getPool(),
  createGithubEnricher({
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  }),
);
console.log(`worker processed ${processed} queued deliveries`);
await getPool().end();
