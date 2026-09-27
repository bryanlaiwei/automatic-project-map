import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifySupabaseUser } from "./auth.js";

function userResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Supabase user check", () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://supabase.test";
    process.env.SUPABASE_ANON_KEY = "anon";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of [
      ["SUPABASE_URL", saved.url],
      ["SUPABASE_ANON_KEY", saved.key],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("takes the GitHub login from the GitHub identity, not from metadata the user can edit", async () => {
    vi.stubGlobal("fetch", async () =>
      userResponse({
        id: "user-1",
        user_metadata: { user_name: "victim", full_name: "Someone Else" },
        identities: [
          { provider: "email", identity_data: { email: "me@example.com" } },
          { provider: "github", identity_data: { user_name: "real-me", full_name: "Real Me", avatar_url: "https://avatars.test/1" } },
        ],
      }),
    );
    await expect(verifySupabaseUser("token")).resolves.toEqual({
      id: "user-1",
      githubLogin: "real-me",
      name: "Real Me",
      avatarUrl: "https://avatars.test/1",
    });
  });

  it("has no GitHub login for an account that did not sign in with GitHub", async () => {
    vi.stubGlobal("fetch", async () =>
      userResponse({ id: "user-2", user_metadata: { user_name: "victim" }, identities: [{ provider: "email", identity_data: {} }] }),
    );
    await expect(verifySupabaseUser("token")).resolves.toEqual({ id: "user-2", githubLogin: null, name: null, avatarUrl: null });
  });
});
