import { assertConfig } from "@apm/core/config";
import { startDeliveryPublisher } from "@apm/core/delivery-jobs";

let settings: ReturnType<typeof assertConfig>;
try {
  settings = assertConfig("api");
} catch (error) {
  console.error(error instanceof Error ? error.message : "API configuration is invalid.");
  process.exit(1);
}

const { createApp } = await import("./app.js");
const { verifySupabaseUser } = await import("./auth.js");
const { getPool } = await import("@apm/core/db");
const { createGithubAccountLookup, createGithubRepositoryAccessCheck } = await import("@apm/github-collector/access");

const githubApp = {
  appId: settings.githubAppId,
  privateKey: settings.githubAppPrivateKey,
};

let enqueueDeliveryProcessing: (deliveryId: string) => Promise<void>;
try {
  const deliveries = await startDeliveryPublisher(settings.databaseUrl);
  enqueueDeliveryProcessing = (deliveryId) => deliveries.enqueue(deliveryId);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the webhook job queue.");
  process.exit(1);
}

const pool = getPool();
const app = createApp({
  pool,
  webhookSecret: settings.githubWebhookSecret ?? "",
  verifyUser: (token) => verifySupabaseUser(token, pool),
  verifyRepositoryAccess: createGithubRepositoryAccessCheck(githubApp),
  lookupGithubAccount: createGithubAccountLookup(githubApp),
  enqueueDeliveryProcessing,
});

app.listen(settings.apiPort, "127.0.0.1", () => {
  console.log(`api listening on http://127.0.0.1:${settings.apiPort}`);
});
