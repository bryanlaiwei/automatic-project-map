import { readWebhookSecret } from "@apm/github-collector/webhook";
import { startDeliveryPublisher } from "./delivery-jobs.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

let webhookSecret: string;
try {
  webhookSecret = readWebhookSecret();
} catch (error) {
  console.error(error instanceof Error ? error.message : "GITHUB_WEBHOOK_SECRET is missing or empty.");
  process.exit(1);
}

const { createApp } = await import("./app.js");
const { verifySupabaseUser } = await import("./auth.js");
const { getPool } = await import("./db.js");
const { createGithubAccountLookup, createGithubRepositoryAccessCheck } = await import("@apm/github-collector/access");

const githubApp = {
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

let enqueueDeliveryProcessing: (deliveryId: string) => Promise<void>;
try {
  const deliveries = await startDeliveryPublisher(connectionString);
  enqueueDeliveryProcessing = (deliveryId) => deliveries.enqueue(deliveryId);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the webhook job queue.");
  process.exit(1);
}

const pool = getPool();
const app = createApp({
  pool,
  webhookSecret,
  verifyUser: (token) => verifySupabaseUser(token, pool),
  verifyRepositoryAccess: createGithubRepositoryAccessCheck(githubApp),
  lookupGithubAccount: createGithubAccountLookup(githubApp),
  enqueueDeliveryProcessing,
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen(port, "127.0.0.1", () => {
  console.log(`api listening on http://127.0.0.1:${port}`);
});
