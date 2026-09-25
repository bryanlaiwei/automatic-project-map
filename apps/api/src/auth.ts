export type AuthUser = {
  id: string;
  githubLogin?: string | null;
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
  const metadata = "user_metadata" in body && typeof body.user_metadata === "object" && body.user_metadata !== null ? body.user_metadata : {};
  return {
    id: body.id,
    githubLogin: text(metadata, "user_name") ?? text(metadata, "preferred_username"),
    name: text(metadata, "full_name") ?? text(metadata, "name"),
    avatarUrl: text(metadata, "avatar_url"),
  };
}

function text(value: object, key: string): string | null {
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : null;
}
