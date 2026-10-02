import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  databaseUrl: string | null;
  githubWebhookSecret: string | null;
  githubAppId: string;
  githubAppPrivateKey: string;
  apiPort: number;
  webOrigin: string;
  supabaseUrl: string | null;
  supabaseJwtSecret: string | null;
  openAiApiKey: string | null;
  openAiModel: string | null;
  secretsKey: string | null;
};

let envLoaded = false;

/** Loads the repo `.env` without replacing variables the process already has. Missing file is fine. */
export function loadEnvFile(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
  if (!existsSync(envPath)) {
    return;
  }
  process.loadEnvFile(envPath);
}

function text(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** The one place server code reads process.env. Call loadEnvFile() before this at startup. */
export function config(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadEnvFile();
  const portText = env.API_PORT?.trim();
  const apiPort = portText ? Number(portText) : 4000;
  if (!Number.isInteger(apiPort) || apiPort <= 0) {
    throw new Error("API_PORT must be a positive integer.");
  }
  return {
    databaseUrl: text(env, "DATABASE_URL"),
    githubWebhookSecret: text(env, "GITHUB_WEBHOOK_SECRET"),
    githubAppId: env.GITHUB_APP_ID?.trim() ?? "",
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
    apiPort,
    webOrigin: text(env, "WEB_ORIGIN") ?? "http://127.0.0.1:5173",
    supabaseUrl: text(env, "SUPABASE_URL"),
    supabaseJwtSecret: text(env, "SUPABASE_JWT_SECRET"),
    openAiApiKey: text(env, "OPENAI_API_KEY"),
    openAiModel: text(env, "OPENAI_MODEL"),
    secretsKey: text(env, "APM_SECRETS_KEY"),
  };
}

function requireDatabase(value: AppConfig): asserts value is AppConfig & { databaseUrl: string } {
  if (!value.databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }
}

/** Checks the settings this process cannot run without. Other settings stay empty until a feature needs them. */
export function assertConfig(service: "api" | "worker"): AppConfig & { databaseUrl: string } {
  const settings = config();
  requireDatabase(settings);
  if (service === "api" && !settings.githubWebhookSecret) {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET is missing or empty. Refusing to start because an empty secret would accept forged webhooks.",
    );
  }
  return settings;
}
