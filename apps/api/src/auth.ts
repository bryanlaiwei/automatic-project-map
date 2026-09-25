export type AuthUser = { id: string };

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
  return { id: body.id };
}
