import { createSign } from "node:crypto";

export type RepositoryAccess =
  | { status: "accessible"; repoId?: number }
  | { status: "denied" }
  | { status: "not_configured"; message: string }
  | { status: "unavailable"; message: string };

/** Without a repoId, the check reports the id GitHub has for owner/name. */
export type RepositoryAccessCheck = (input: {
  owner: string;
  name: string;
  repoId?: number | undefined;
}) => Promise<RepositoryAccess>;

const githubApi = "https://api.github.com";

export function createGithubRepositoryAccessCheck(input: {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
}): RepositoryAccessCheck {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async ({ owner, name, repoId }) => {
    if (input.appId.trim() === "" || input.privateKey.trim() === "") {
      return {
        status: "not_configured",
        message: "GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
      };
    }

    try {
      const jwt = signGithubAppJwt(input.appId.trim(), input.privateKey);
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const installation = await githubRequest(fetchImpl, `${repoPath}/installation`, jwt, "GET");
      if (installation.status === 404) {
        return { status: "denied" };
      }
      if (!installation.ok) {
        return {
          status: "unavailable",
          message: "GitHub did not confirm the App installation for this repository.",
        };
      }
      const installationId = readNumberId(installation.body);
      if (installationId === null) {
        return { status: "unavailable", message: "GitHub installation response did not include an id." };
      }

      const tokenResponse = await githubRequest(
        fetchImpl,
        `/app/installations/${installationId}/access_tokens`,
        jwt,
        "POST",
      );
      if (!tokenResponse.ok) {
        return { status: "unavailable", message: "Could not create a GitHub App installation token." };
      }
      const token = readToken(tokenResponse.body);
      if (token === null) {
        return { status: "unavailable", message: "GitHub did not return an installation token." };
      }

      const repo = await githubRequest(fetchImpl, repoPath, token, "GET");
      if (repo.status === 404) {
        return { status: "denied" };
      }
      if (!repo.ok) {
        return {
          status: "unavailable",
          message: "Could not read the repository with the GitHub App installation.",
        };
      }
      const confirmedId = readNumberId(repo.body);
      if (confirmedId === null || (repoId !== undefined && confirmedId !== repoId)) {
        return { status: "denied" };
      }
      return { status: "accessible", repoId: confirmedId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub App authentication failed.";
      return { status: "unavailable", message };
    }
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

async function githubRequest(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  method: "GET" | "POST",
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetchImpl(`${githubApi}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "automatic-project-map",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function readNumberId(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "number") {
    return null;
  }
  return body.id;
}

function readToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
    return null;
  }
  return body.token.length > 0 ? body.token : null;
}
