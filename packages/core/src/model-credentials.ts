import type { Pool } from "pg";
import { modelCredentialSchema, type ModelCredential } from "@apm/shared";
import type { Interpreter } from "./graph/process.js";
import { createModelInterpreter } from "./graph/model-interpreter.js";
import { graphPromptVersion } from "./graph/graph-prompt.js";
import { openAiInterpreterFromEnv } from "./graph/openai-interpreter.js";
import { isModelProviderId, modelProvider, type ModelProviderId } from "./model-providers.js";
import { ciphertextBuffer, ModelSecretsError, openModelKey, sealModelKey } from "./secret-box.js";

export type PublicModelCredential = ModelCredential;

type CredentialRow = {
  provider: string;
  model: string;
  key_hint: string;
  updated_at: Date;
};

export async function readModelCredential(pool: Pool, userId: string): Promise<PublicModelCredential | null> {
  const result = await pool.query<CredentialRow>(
    `select provider, model, key_hint, updated_at from user_model_credentials where user_id = $1`,
    [userId],
  );
  return publicCredential(result.rows[0]);
}

export async function saveModelCredential(
  pool: Pool,
  userId: string,
  input: { provider: ModelProviderId; apiKey: string; model: string },
): Promise<PublicModelCredential> {
  const hint = input.apiKey.slice(-4);
  await pool.query(
    `insert into user_model_credentials (user_id, provider, model, key_ciphertext, key_hint, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (user_id) do update
       set provider = excluded.provider,
           model = excluded.model,
           key_ciphertext = excluded.key_ciphertext,
           key_hint = excluded.key_hint,
           updated_at = now()`,
    [userId, input.provider, input.model, sealModelKey(input.apiKey), hint],
  );
  const saved = await readModelCredential(pool, userId);
  if (!saved) {
    throw new Error("Saving the model key did not store it.");
  }
  return saved;
}

export async function readStoredModelKey(
  pool: Pool,
  userId: string,
): Promise<{ provider: ModelProviderId; apiKey: string; model: string } | null> {
  const result = await pool.query<{ provider: string; model: string; key_ciphertext: unknown }>(
    `select provider, model, key_ciphertext from user_model_credentials where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row || !isModelProviderId(row.provider)) {
    return null;
  }
  return {
    provider: row.provider,
    model: row.model,
    apiKey: openModelKey(ciphertextBuffer(row.key_ciphertext)),
  };
}

export async function deleteModelCredential(pool: Pool, userId: string): Promise<void> {
  await pool.query(`delete from user_model_credentials where user_id = $1`, [userId]);
}

/** The supplier of the owner key saved most recently, if any owner of this workspace has one. */
export async function ownerModelSource(pool: Pool, workspaceId: string): Promise<ModelProviderId | null> {
  const result = await pool.query<{ provider: string }>(
    `select c.provider
     from memberships m
     join user_model_credentials c on c.user_id = m.user_id
     where m.workspace_id = $1 and m.role = 'owner'
     order by c.updated_at desc
     limit 1`,
    [workspaceId],
  );
  const provider = result.rows[0]?.provider;
  return provider && isModelProviderId(provider) ? provider : null;
}

/**
 * The interpreter for a project. An owner's saved key wins over the server OpenAI key. When several owners
 * have saved a key, the one updated most recently is used. Decrypt failures stay visible as a failed analysis
 * instead of silently switching to the server key.
 */
export async function resolveProjectInterpreter(pool: Pool, projectId: string): Promise<Interpreter | null> {
  const result = await pool.query<{ provider: string; model: string; key_ciphertext: unknown }>(
    `select c.provider, c.model, c.key_ciphertext
     from projects p
     join memberships m on m.workspace_id = p.workspace_id and m.role = 'owner'
     join user_model_credentials c on c.user_id = m.user_id
     where p.id = $1
     order by c.updated_at desc
     limit 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) {
    return openAiInterpreterFromEnv();
  }
  if (!isModelProviderId(row.provider)) {
    return failingInterpreter("The saved model supplier is not supported.");
  }
  try {
    const apiKey = openModelKey(ciphertextBuffer(row.key_ciphertext));
    return createModelInterpreter({ provider: row.provider, apiKey, model: row.model });
  } catch (error) {
    if (error instanceof ModelSecretsError) {
      return failingInterpreter(error.message);
    }
    throw error;
  }
}

export function resolvedModel(provider: ModelProviderId, requested: string): string {
  return requested.trim() || modelProvider(provider).defaultModel;
}

function publicCredential(row: CredentialRow | undefined): PublicModelCredential | null {
  if (!row || !isModelProviderId(row.provider)) {
    return null;
  }
  return modelCredentialSchema.parse({
    provider: row.provider,
    model: row.model,
    hint: row.key_hint,
    updatedAt: row.updated_at.toISOString(),
  });
}

function failingInterpreter(message: string): Interpreter {
  return {
    model: "unavailable",
    promptVersion: graphPromptVersion,
    async interpret() {
      throw new Error(message);
    },
  };
}
