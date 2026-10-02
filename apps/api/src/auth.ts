import { jwtVerify, type JWTVerifyOptions } from "jose";
import type { Pool } from "pg";
import type { AuthUser } from "@apm/core/auth-user";
import { config } from "@apm/core/config";

export type { AuthUser };

const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Confirms a Supabase access token without calling Auth.
 * The GitHub account is read from auth.identities. The JWT's user_metadata is ignored because any
 * signed-in user can rewrite it with auth.updateUser, and Supabase copies that rewrite into the next token.
 */
export async function verifySupabaseUser(token: string, pool: Pool): Promise<AuthUser | null> {
  const id = await supabaseUserId(token);
  if (!id) {
    return null;
  }
  const github = await githubAccount(pool, id);
  return { id, ...github };
}

async function supabaseUserId(token: string): Promise<string | null> {
  const secret = config().supabaseJwtSecret;
  if (!secret || token === "") {
    return null;
  }
  const url = config().supabaseUrl?.replace(/\/$/, "");
  const options: JWTVerifyOptions = { algorithms: ["HS256"], audience: "authenticated" };
  if (url) {
    options.issuer = `${url}/auth/v1`;
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), options);
    if (payload.role !== "authenticated" || typeof payload.sub !== "string" || !userIdPattern.test(payload.sub)) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}

async function githubAccount(pool: Pool, userId: string): Promise<Pick<AuthUser, "githubLogin" | "githubId" | "name" | "avatarUrl">> {
  const result = await pool.query<{ identity_data: unknown }>(
    `select identity_data from auth.identities where user_id = $1 and provider = 'github' order by created_at limit 1`,
    [userId],
  );
  const data = objectValue(result.rows[0]?.identity_data);
  if (!data) {
    return { githubLogin: null, githubId: null, name: null, avatarUrl: null };
  }
  const githubId = text(data, "provider_id") ?? text(data, "sub");
  return {
    githubLogin: text(data, "user_name") ?? text(data, "preferred_username"),
    githubId: githubId !== null && /^\d+$/.test(githubId) ? githubId : null,
    name: text(data, "full_name") ?? text(data, "name"),
    avatarUrl: text(data, "avatar_url"),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function text(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : null;
}
