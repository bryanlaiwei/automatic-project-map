import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthUser } from "./auth.js";
import { getPool } from "@apm/core/db";
import { loadEnvFile } from "@apm/core/config";
import { deleteModelCredential, resolveProjectInterpreter, saveModelCredential } from "@apm/core/model-credentials";
import { openAiInterpreterFromEnv } from "@apm/core/graph/openai-interpreter";
import { ciphertextBuffer, openModelKey } from "@apm/core/secret-box";

loadEnvFile();
if (!process.env.APM_SECRETS_KEY?.trim()) {
  process.env.APM_SECRETS_KEY = "test-secrets-key-for-model-credentials";
}

const pool = getPool();
const people: Record<string, AuthUser> = {
  owner: { id: "e6000000-0000-4000-8000-000000000001", githubLogin: "model-owner", githubId: "6001", name: "Model Owner", avatarUrl: null },
  mate: { id: "e6000000-0000-4000-8000-000000000002", githubLogin: "model-mate", githubId: "6002", name: null, avatarUrl: null },
};
const workspace = "modelkey/app";
const apiKey = "sk-openai-test-key-0001";

describe("saved model keys", () => {
  let server: Server;
  let baseUrl = "";
  let projectId = "";
  const secretsKey = process.env.APM_SECRETS_KEY ?? "";

  beforeAll(async () => {
    await pool.query("delete from workspaces where name = $1", [workspace]);
    await pool.query("delete from user_model_credentials where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    await pool.query("delete from profiles where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    server = createApp({
      pool,
      webhookSecret: "unused",
      verifyUser: async (token) => people[token] ?? null,
      verifyRepositoryAccess: async (input) =>
        input.owner === "modelkey" && input.name === "app" ? { status: "accessible", repoId: 88_006_001 } : { status: "denied" },
      modelKeyCheck: async (input) => (input.apiKey.endsWith("reject") ? { ok: false, error: "That key was rejected." } : { ok: true }),
      listSupplierModels: async (input) => {
        return {
          ok: true,
          models: [{ id: input.provider === "anthropic" ? "claude-haiku-4-5" : "gpt-5-nano", label: "listed" }],
        };
      },
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    process.env.APM_SECRETS_KEY = secretsKey;
    await pool.query("delete from workspaces where name = $1", [workspace]);
    await pool.query("delete from user_model_credentials where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    await pool.query("delete from profiles where user_id = any($1::uuid[])", [Object.values(people).map((person) => person.id)]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function call(who: keyof typeof people | "", path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), "Content-Type": "application/json", ...init.headers },
    });
  }

  it("does not accept a personal model key in this release", async () => {
    expect((await call("", "/me/model")).status).toBe(401);
    expect((await call("owner", "/me/model", { method: "PUT", body: JSON.stringify({ provider: "openai", apiKey, model: "" }) })).status).toBe(404);
    expect((await call("owner", "/me/model/models", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey }) })).status).toBe(404);
    expect((await call("owner", "/me/model", { method: "DELETE" })).status).toBe(404);
  });

  it("saves an owner's key encrypted, and uses the owner key saved most recently", async () => {
    const saved = await saveModelCredential(pool, people.owner?.id ?? "", { provider: "openai", apiKey, model: "gpt-5-nano" });
    expect(saved).toMatchObject({ provider: "openai", model: "gpt-5-nano", hint: "0001" });
    expect(JSON.stringify(saved)).not.toContain(apiKey);

    const stored = await pool.query<{ key_ciphertext: unknown }>(`select key_ciphertext from user_model_credentials where user_id = $1`, [people.owner?.id]);
    const sealed = ciphertextBuffer(stored.rows[0]?.key_ciphertext);
    expect(sealed.toString("utf8")).not.toContain(apiKey);
    expect(openModelKey(sealed)).toBe(apiKey);

    const connected = await call("owner", "/projects", { method: "POST", body: JSON.stringify({ owner: "modelkey", name: "app" }) });
    expect(connected.status).toBe(201);
    projectId = ((await connected.json()) as { project: { id: string } }).project.id;

    const settings = (await (await call("owner", `/projects/${projectId}/settings`)).json()) as {
      health: { analysis: { model: { provider: string; source: string } } };
    };
    const fallbackBeforeDelete = openAiInterpreterFromEnv();
    expect(settings.health.analysis.model).toEqual(
      fallbackBeforeDelete ? { provider: "openai", source: "server" } : { provider: null, source: "none" },
    );
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("gpt-5-nano");

    await saveModelCredential(pool, people.mate?.id ?? "", {
      provider: "anthropic",
      apiKey: "sk-ant-test-key-0002",
      model: "claude-haiku-4-5",
    });
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("gpt-5-nano");

    await pool.query(
      `insert into memberships (workspace_id, user_id, role)
       select workspace_id, $2, 'owner' from projects where id = $1
       on conflict (workspace_id, user_id) do update set role = 'owner'`,
      [projectId, people.mate?.id],
    );
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("claude-haiku-4-5");

    await deleteModelCredential(pool, people.owner?.id ?? "");
    await deleteModelCredential(pool, people.mate?.id ?? "");
    const cleared = (await (await call("owner", "/me/model")).json()) as { credential: unknown };
    expect(cleared.credential).toBeNull();
    const fallback = openAiInterpreterFromEnv();
    expect((await resolveProjectInterpreter(pool, projectId))?.model ?? null).toBe(fallback?.model ?? null);
  });

  it("refuses to save a key when the encryption secret is missing", async () => {
    delete process.env.APM_SECRETS_KEY;
    try {
      await expect(
        saveModelCredential(pool, people.owner?.id ?? "", { provider: "gemini", apiKey, model: "" }),
      ).rejects.toThrow(/APM_SECRETS_KEY/);
    } finally {
      process.env.APM_SECRETS_KEY = secretsKey;
    }
  });
});
