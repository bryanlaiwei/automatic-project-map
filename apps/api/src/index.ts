import { loadEnvFile } from "./env.js";
import { readWebhookSecret } from "./github.js";

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
const { createGithubRepositoryAccessCheck } = await import("./github-app.js");
const { createGithubEnricher } = await import("./github-enrich.js");

const githubApp = {
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
};

const app = createApp({
  pool: getPool(),
  webhookSecret,
  verifyUser: verifySupabaseUser,
  verifyRepositoryAccess: createGithubRepositoryAccessCheck(githubApp),
  github: createGithubEnricher(githubApp),
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen(port, "127.0.0.1", () => {
  console.log(`api listening on http://127.0.0.1:${port}`);
});
