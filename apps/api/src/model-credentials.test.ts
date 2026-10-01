import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AuthUser } from "./auth.js";
import { getPool } from "./db.js";
import { loadEnvFile } from "./env.js";
import { resolveProjectInterpreter } from "./model-credentials.js";
import { openAiInterpreterFromEnv } from "./graph/openai-interpreter.js";
import { ciphertextBuffer, openModelKey } from "./secret-box.js";

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
const listedKeys: string[] = [];

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
        listedKeys.push(input.apiKey);
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

  it("saves an owner's key encrypted, and uses the owner key saved most recently", async () => {
    expect((await call("", "/me/model")).status).toBe(401);
    expect((await call("owner", "/me/model", { method: "PUT", body: JSON.stringify({ provider: "other", apiKey, model: "" }) })).status).toBe(400);

    const rejected = await call("owner", "/me/model", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test-key-reject", model: "" }),
    });
    expect(rejected.status).toBe(400);
    expect(await readHint("owner")).toBeNull();

    const saved = await call("owner", "/me/model", { method: "PUT", body: JSON.stringify({ provider: "openai", apiKey, model: "" }) });
    expect(saved.status).toBe(200);
    const credential = (await saved.json()) as { provider: string; model: string; hint: string };
    expect(credential).toMatchObject({ provider: "openai", model: "gpt-5-nano", hint: "0001" });
    expect(JSON.stringify(credential)).not.toContain(apiKey);

    const stored = await pool.query<{ key_ciphertext: unknown }>(`select key_ciphertext from user_model_credentials where user_id = $1`, [people.owner?.id]);
    const sealed = ciphertextBuffer(stored.rows[0]?.key_ciphertext);
    expect(sealed.toString("utf8")).not.toContain(apiKey);
    expect(openModelKey(sealed)).toBe(apiKey);

    const listed = await call("owner", "/me/model/models", { method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "" }) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ models: [{ id: "gpt-5-nano", label: "listed" }] });
    expect(listedKeys.at(-1)).toBe(apiKey);
    expect((await call("owner", "/me/model/models", { method: "POST", body: JSON.stringify({ provider: "gemini", apiKey: "" }) })).status).toBe(400);

    const connected = await call("owner", "/projects", { method: "POST", body: JSON.stringify({ owner: "modelkey", name: "app" }) });
    expect(connected.status).toBe(201);
    projectId = ((await connected.json()) as { project: { id: string } }).project.id;

    const settings = (await (await call("owner", `/projects/${projectId}/settings`)).json()) as {
      health: { analysis: { model: { provider: string; source: string } } };
    };
    expect(settings.health.analysis.model).toEqual({ provider: "openai", source: "owner" });
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("gpt-5-nano");

    const mateSaved = await call("mate", "/me/model", {
      method: "PUT",
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key-0002", model: "claude-haiku-4-5" }),
    });
    expect(mateSaved.status).toBe(200);
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("gpt-5-nano");

    await pool.query(
      `insert into memberships (workspace_id, user_id, role)
       select workspace_id, $2, 'owner' from projects where id = $1
       on conflict (workspace_id, user_id) do update set role = 'owner'`,
      [projectId, people.mate?.id],
    );
    expect((await resolveProjectInterpreter(pool, projectId))?.model).toBe("claude-haiku-4-5");

    expect((await call("owner", "/me/model", { method: "DELETE" })).status).toBe(204);
    expect((await call("mate", "/me/model", { method: "DELETE" })).status).toBe(204);
    const cleared = (await (await call("owner", "/me/model")).json()) as { credential: unknown };
    expect(cleared.credential).toBeNull();
    const fallback = openAiInterpreterFromEnv();
    expect((await resolveProjectInterpreter(pool, projectId))?.model ?? null).toBe(fallback?.model ?? null);
  });

  it("refuses to save a key when the encryption secret is missing", async () => {
    delete process.env.APM_SECRETS_KEY;
    try {
      const response = await call("owner", "/me/model", { method: "PUT", body: JSON.stringify({ provider: "gemini", apiKey, model: "" }) });
      expect(response.status).toBe(503);
    } finally {
      process.env.APM_SECRETS_KEY = secretsKey;
    }
  });
});

async function readHint(who: keyof typeof people): Promise<string | null> {
  const result = await pool.query<{ key_hint: string }>(`select key_hint from user_model_credentials where user_id = $1`, [people[who]?.id]);
  return result.rows[0]?.key_hint ?? null;
}
