import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  databaseUrl: string | null;
  databasePoolMax: number;
  githubWebhookSecret: string | null;
  githubAppId: string;
  githubAppPrivateKey: string;
  apiHost: string;
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
  const envPath = repoEnvPath();
  if (!existsSync(envPath)) {
    return;
  }
  process.loadEnvFile(envPath);
}

/** Works both from `src/` (dev) and `dist/` (the compiled server). */
function repoEnvPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const packagePath = resolve(dir, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
        if (isRepoPackage(parsed)) {
          return resolve(dir, ".env");
        }
      } catch {
        // A package.json that is not the repo root is not an error. Keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
}

function isRepoPackage(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "automatic-project-map";
}

function text(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** The one place server code reads process.env. Call loadEnvFile() before this at startup. */
export function config(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadEnvFile();
  return {
    databaseUrl: text(env, "DATABASE_URL"),
    databasePoolMax: positiveInteger(env.DATABASE_POOL_MAX, "DATABASE_POOL_MAX", 10),
    githubWebhookSecret: text(env, "GITHUB_WEBHOOK_SECRET"),
    githubAppId: env.GITHUB_APP_ID?.trim() ?? "",
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
    apiHost: apiHost(env),
    apiPort: apiPort(env),
    webOrigin: text(env, "WEB_ORIGIN") ?? "http://127.0.0.1:5173",
    supabaseUrl: text(env, "SUPABASE_URL"),
    supabaseJwtSecret: text(env, "SUPABASE_JWT_SECRET"),
    openAiApiKey: text(env, "OPENAI_API_KEY"),
    openAiModel: text(env, "OPENAI_MODEL"),
    secretsKey: text(env, "APM_SECRETS_KEY"),
  };
}

function positiveInteger(value: string | undefined, label: string, fallback: number): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

/** A host sets PORT. API_PORT is the local name. */
function apiPort(env: NodeJS.ProcessEnv): number {
  if (env.PORT?.trim()) {
    return positiveInteger(env.PORT, "PORT", 4000);
  }
  return positiveInteger(env.API_PORT, "API_PORT", 4000);
}

/** Production start listens on every interface. Local dev stays on this machine unless HOST is set. */
function apiHost(env: NodeJS.ProcessEnv): string {
  const host = text(env, "HOST");
  if (host) {
    return host;
  }
  return env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
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
