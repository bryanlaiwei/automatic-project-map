export type AuthUser = {
  id: string;
  githubLogin?: string | null;
  /** GitHub's numeric account id, as a decimal string. Unlike the login, it never changes hands. */
  githubId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
};

export async function verifySupabaseUser(token: string): Promise<AuthUser | null> {
  const url = process.env.SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !apiKey || token === "") {
    return null;
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: apiKey,
    },
  });
  if (!response.ok) {
    return null;
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    return null;
  }
  const github = githubIdentity(body);
  const githubId = github ? (text(github, "provider_id") ?? text(github, "sub")) : null;
  return {
    id: body.id,
    githubLogin: github ? (text(github, "user_name") ?? text(github, "preferred_username")) : null,
    githubId: githubId !== null && /^\d+$/.test(githubId) ? githubId : null,
    name: github ? (text(github, "full_name") ?? text(github, "name")) : null,
    avatarUrl: github ? text(github, "avatar_url") : null,
  };
}

/**
 * The GitHub account the user signed in with. Supabase fills `identities` from the provider at sign-in;
 * `user_metadata` is not used because any signed-in user can rewrite it with `auth.updateUser`.
 */
function githubIdentity(body: object): object | null {
  const identities = "identities" in body && Array.isArray(body.identities) ? (body.identities as unknown[]) : [];
  for (const identity of identities) {
    if (typeof identity !== "object" || identity === null) {
      continue;
    }
    const record = identity as Record<string, unknown>;
    if (record.provider === "github" && typeof record.identity_data === "object" && record.identity_data !== null) {
      return record.identity_data;
    }
  }
  return null;
}

function text(value: object, key: string): string | null {
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : null;
}
