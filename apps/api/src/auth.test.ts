import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import type { Pool } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifySupabaseUser } from "./auth.js";

const secretText = "test-secret-with-at-least-32-characters";
const secret = new TextEncoder().encode(secretText);
const userId = "11111111-1111-4111-8111-111111111111";

async function accessToken(input?: { role?: string; audience?: string; issuer?: string; expiresIn?: string; subject?: string; key?: Uint8Array }): Promise<string> {
  return new SignJWT({ role: input?.role ?? "authenticated", user_metadata: { user_name: "victim", full_name: "Someone Else" } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input?.subject ?? userId)
    .setIssuer(input?.issuer ?? "http://supabase.test/auth/v1")
    .setAudience(input?.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(input?.expiresIn ?? "1h")
    .sign(input?.key ?? secret);
}

function identityPool(identityData: Record<string, unknown> | null): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: identityData ? [{ identity_data: identityData }] : [] };
    }),
  } as unknown as Pool;
  return { pool, queries };
}

describe("Supabase user check", () => {
  const saved = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_JWT_SECRET };

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://supabase.test";
    process.env.SUPABASE_JWT_SECRET = secretText;
  });

  afterEach(() => {
    for (const [name, value] of [
      ["SUPABASE_URL", saved.url],
      ["SUPABASE_JWT_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("takes the GitHub login from auth.identities, not from metadata the user can edit", async () => {
    const { pool, queries } = identityPool({
      user_name: "real-me",
      provider_id: "583231",
      full_name: "Real Me",
      avatar_url: "https://avatars.test/1",
    });
    await expect(verifySupabaseUser(await accessToken(), pool)).resolves.toEqual({
      id: userId,
      githubLogin: "real-me",
      githubId: "583231",
      name: "Real Me",
      avatarUrl: "https://avatars.test/1",
    });
    expect(queries).toEqual([`select identity_data from auth.identities where user_id = $1 and provider = 'github' order by created_at limit 1`]);
  });

  it("has no GitHub login for an account that did not sign in with GitHub", async () => {
    const { pool } = identityPool(null);
    await expect(verifySupabaseUser(await accessToken(), pool)).resolves.toEqual({
      id: userId,
      githubLogin: null,
      githubId: null,
      name: null,
      avatarUrl: null,
    });
  });

  it("rejects a token that was not signed with the project secret", async () => {
    const { pool, queries } = identityPool({ user_name: "real-me" });
    const token = await accessToken({ key: new TextEncoder().encode("another-secret-with-at-least-32-chars") });
    await expect(verifySupabaseUser(token, pool)).resolves.toBeNull();
    expect(queries).toEqual([]);
  });

  it("rejects an expired token", async () => {
    const { pool, queries } = identityPool({ user_name: "real-me" });
    await expect(verifySupabaseUser(await accessToken({ expiresIn: "-1m" }), pool)).resolves.toBeNull();
    expect(queries).toEqual([]);
  });

  it("rejects the anon key and other non-user tokens", async () => {
    const { pool } = identityPool({ user_name: "real-me" });
    await expect(verifySupabaseUser(await accessToken({ role: "anon", audience: "anon" }), pool)).resolves.toBeNull();
    await expect(verifySupabaseUser(await accessToken({ role: "service_role" }), pool)).resolves.toBeNull();
    await expect(verifySupabaseUser(await accessToken({ issuer: "http://other.test/auth/v1" }), pool)).resolves.toBeNull();
    await expect(verifySupabaseUser(await accessToken({ subject: "not-a-user-id" }), pool)).resolves.toBeNull();
    await expect(verifySupabaseUser("", pool)).resolves.toBeNull();
  });

  it("returns null when the signing secret is not configured", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const { pool, queries } = identityPool({ user_name: "real-me" });
    await expect(verifySupabaseUser(await accessToken(), pool)).resolves.toBeNull();
    expect(queries).toEqual([]);
  });
});

describe("Supabase user check with signing keys", () => {
  const saved = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_JWT_SECRET };
  const kid = "test-signing-key";
  let signingKey: CryptoKey;
  let jwksRequests: string[];

  async function signedToken(input?: { key?: CryptoKey; role?: string }): Promise<string> {
    return new SignJWT({ role: input?.role ?? "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(userId)
      .setIssuer("http://supabase.test/auth/v1")
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(input?.key ?? signingKey);
  }

  let jwk: Record<string, unknown>;

  // The API caches the key set per Supabase URL, so every test in this block shares one key pair.
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signingKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
  });

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://supabase.test";
    delete process.env.SUPABASE_JWT_SECRET;
    jwksRequests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        jwksRequests.push(String(url));
        return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of [
      ["SUPABASE_URL", saved.url],
      ["SUPABASE_JWT_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("accepts a token signed with the project's published signing key, without the shared secret", async () => {
    const { pool } = identityPool({ user_name: "real-me", provider_id: "583231" });
    await expect(verifySupabaseUser(await signedToken(), pool)).resolves.toMatchObject({ id: userId, githubLogin: "real-me" });
    expect(jwksRequests).toEqual(["http://supabase.test/auth/v1/.well-known/jwks.json"]);
  });

  it("rejects a token signed with some other key or for a non-user role", async () => {
    const { pool, queries } = identityPool({ user_name: "real-me" });
    const other = await generateKeyPair("ES256");
    await expect(verifySupabaseUser(await signedToken({ key: other.privateKey }), pool)).resolves.toBeNull();
    await expect(verifySupabaseUser(await signedToken({ role: "service_role" }), pool)).resolves.toBeNull();
    expect(queries).toEqual([]);
  });
});
