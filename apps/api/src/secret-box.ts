import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const salt = "apm-model-credential-v1";
let cached: { secret: string; key: Buffer } | null = null;

export class ModelSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSecretsError";
  }
}

export function modelSecretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.APM_SECRETS_KEY?.trim());
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = env.APM_SECRETS_KEY?.trim();
  if (!secret) {
    throw new ModelSecretsError("Set APM_SECRETS_KEY before saving a model key. It encrypts keys at rest.");
  }
  if (cached?.secret === secret) {
    return cached.key;
  }
  const key = scryptSync(secret, salt, 32);
  cached = { secret, key };
  return key;
}

/** iv (12) || auth tag (16) || ciphertext. */
export function sealModelKey(plaintext: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function openModelKey(payload: Buffer, env: NodeJS.ProcessEnv = process.env): string {
  if (payload.length < 12 + 16 + 1) {
    throw new ModelSecretsError("The saved model key is unreadable.");
  }
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new ModelSecretsError("The saved model key could not be decrypted. APM_SECRETS_KEY may have changed.");
  }
}

/** node-pg returns bytea as a Buffer. A hex escape is accepted too, in case a driver hands one back. */
export function ciphertextBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Buffer.from(value.slice(2), "hex");
  }
  throw new ModelSecretsError("The saved model key is unreadable.");
}
