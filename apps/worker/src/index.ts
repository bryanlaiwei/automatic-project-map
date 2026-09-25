import { loadEnvFile } from "@apm/api/env";

loadEnvFile();

const { getPool } = await import("@apm/api/db");
const { processQueuedDeliveries } = await import("@apm/api/store");

const processed = await processQueuedDeliveries(getPool());
console.log(`worker processed ${processed} queued deliveries`);
await getPool().end();
