import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../../.env");
  if (!existsSync(envPath)) {
    return;
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
