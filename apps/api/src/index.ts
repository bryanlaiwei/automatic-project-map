import { loadEnvFile } from "./env.js";

loadEnvFile();

const { createApp } = await import("./app.js");
const { verifySupabaseUser } = await import("./auth.js");
const { getPool } = await import("./db.js");

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const app = createApp({
  pool: getPool(),
  webhookSecret: secret,
  verifyUser: verifySupabaseUser,
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen(port, "127.0.0.1", () => {
  console.log(`api listening on http://127.0.0.1:${port}`);
});
