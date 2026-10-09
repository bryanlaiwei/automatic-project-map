import { assertConfig } from "@apm/core/config";
import { startDeliveryPublisher, type DeliveryPublisher } from "@apm/core/delivery-jobs";

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

let deliveries: DeliveryPublisher;
try {
  deliveries = await startDeliveryPublisher(settings.databaseUrl);
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
  enqueueDeliveryProcessing: (deliveryId) => deliveries.enqueue(deliveryId),
});

const server = app.listen(settings.apiPort, settings.apiHost, () => {
  console.log(`api listening on http://${settings.apiHost}:${settings.apiPort}`);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await deliveries.stop();
    await pool.end();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "API shutdown failed.");
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
