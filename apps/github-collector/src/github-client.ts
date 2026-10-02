import { createSign } from "node:crypto";

export const githubApi = "https://api.github.com";
export const githubTimeoutMs = 15_000;

const tokenReuseMarginMs = 5 * 60_000;

export type GithubResponse = { ok: boolean; status: number; body: unknown };

export type InstallationToken =
  | { status: "ok"; token: string; expiresAt: number }
  | { status: "denied" }
  | { status: "unavailable"; message: string };

type CachedToken = { token: string; expiresAt: number };

export function createGithubClient(input: { appId: string; privateKey: string; fetchImpl?: typeof fetch; now?: () => number }) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const tokens = new Map<string, CachedToken>();

  return {
    async installationToken(owner: string, name: string): Promise<InstallationToken> {
      const key = `${owner}/${name}`.toLowerCase();
      const cached = tokens.get(key);
      if (cached && cached.expiresAt - tokenReuseMarginMs > now()) {
        return { status: "ok", token: cached.token, expiresAt: cached.expiresAt };
      }
      const fresh = await requestInstallationToken(fetchImpl, input.appId, input.privateKey, owner, name);
      if (fresh.status === "ok") {
        tokens.set(key, { token: fresh.token, expiresAt: fresh.expiresAt });
      }
      return fresh;
    },
    request(path: string, token: string, method: "GET" | "POST"): Promise<GithubResponse> {
      return githubRequest(fetchImpl, path, token, method);
    },
  };
}

export function signGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(normalizePem(privateKey)).toString("base64url")}`;
}

function normalizePem(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "automatic-project-map",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function githubRequest(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  method: "GET" | "POST",
): Promise<GithubResponse> {
  const response = await fetchImpl(`${githubApi}${path}`, {
    method,
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(githubTimeoutMs),
  });
  const body: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function requestInstallationToken(
  fetchImpl: typeof fetch,
  appId: string,
  privateKey: string,
  owner: string,
  name: string,
): Promise<InstallationToken> {
  if (appId.trim() === "" || privateKey.trim() === "") {
    return { status: "unavailable", message: "GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY." };
  }
  try {
    const jwt = signGithubAppJwt(appId.trim(), privateKey);
    const installation = await githubRequest(
      fetchImpl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      jwt,
      "GET",
    );
    if (installation.status === 404) {
      return { status: "denied" };
    }
    if (!installation.ok) {
      return { status: "unavailable", message: "GitHub did not confirm the App installation for this repository." };
    }
    const installationId = readNumberId(installation.body);
    if (installationId === null) {
      return { status: "unavailable", message: "GitHub installation response did not include an id." };
    }
    const tokenResponse = await githubRequest(fetchImpl, `/app/installations/${installationId}/access_tokens`, jwt, "POST");
    if (!tokenResponse.ok) {
      return { status: "unavailable", message: "Could not create a GitHub App installation token." };
    }
    const token = readToken(tokenResponse.body);
    if (token === null) {
      return { status: "unavailable", message: "GitHub did not return an installation token." };
    }
    return { status: "ok", token, expiresAt: readExpiry(tokenResponse.body) };
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : "GitHub App authentication failed." };
  }
}

function readNumberId(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "number") {
    return null;
  }
  return body.id;
}

function readToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string" || body.token.length === 0) {
    return null;
  }
  return body.token;
}

function readExpiry(body: unknown): number {
  if (typeof body !== "object" || body === null || !("expires_at" in body) || typeof body.expires_at !== "string") {
    return 0;
  }
  const expiresAt = Date.parse(body.expires_at);
  return Number.isNaN(expiresAt) ? 0 : expiresAt;
}
