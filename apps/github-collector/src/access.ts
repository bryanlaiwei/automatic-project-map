import { createGithubClient } from "./github-client.js";

export type RepositoryAccess =
  | { status: "accessible"; repoId?: number }
  | { status: "denied" }
  | { status: "not_permitted"; message: string }
  | { status: "not_configured"; message: string }
  | { status: "unavailable"; message: string };

/**
 * Without a repoId, the check reports the id GitHub has for owner/name. `login` is the signed-in person's
 * GitHub account, which must be able to push to the repository.
 */
export type RepositoryAccessCheck = (input: {
  owner: string;
  name: string;
  repoId?: number | undefined;
  login: string | null;
}) => Promise<RepositoryAccess>;

const connectingPermissions = new Set(["admin", "write"]);

const missingApp = {
  status: "not_configured" as const,
  message: "GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
};

export function createGithubRepositoryAccessCheck(input: {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
}): RepositoryAccessCheck {
  const client = createGithubClient(input);
  return async ({ owner, name, repoId, login }) => {
    if (input.appId.trim() === "" || input.privateKey.trim() === "") {
      return missingApp;
    }
    if (login === null) {
      return { status: "not_permitted", message: "Sign in with GitHub to connect a repository." };
    }

    try {
      const installation = await client.installationToken(owner, name);
      if (installation.status !== "ok") {
        return installation.status === "denied" ? { status: "denied" } : installation;
      }
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const repo = await client.request(repoPath, installation.token, "GET");
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
      const permission = await client.request(
        `${repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
        installation.token,
        "GET",
      );
      const level =
        typeof permission.body === "object" && permission.body !== null && "permission" in permission.body
          ? permission.body.permission
          : null;
      if (permission.ok && typeof level === "string" && connectingPermissions.has(level)) {
        return { status: "accessible", repoId: confirmedId };
      }
      if (permission.ok || permission.status === 404 || permission.status === 403) {
        return { status: "not_permitted", message: `@${login} needs write access to ${owner}/${name} on GitHub to connect it.` };
      }
      return { status: "unavailable", message: "GitHub did not confirm your access to this repository." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub App authentication failed.";
      return { status: "unavailable", message };
    }
  };
}

export type GithubAccount =
  | { status: "found"; id: number; login: string }
  | { status: "not_found" }
  | { status: "unavailable"; message: string };

/** Resolves a GitHub username to the person's account, through the App installation on the project's repository. */
export type GithubAccountLookup = (input: { owner: string; name: string; login: string }) => Promise<GithubAccount>;

export function createGithubAccountLookup(input: { appId: string; privateKey: string; fetchImpl?: typeof fetch }): GithubAccountLookup {
  const client = createGithubClient(input);
  return async ({ owner, name, login }) => {
    if (input.appId.trim() === "" || input.privateKey.trim() === "") {
      return { status: "unavailable", message: missingApp.message };
    }
    try {
      const installation = await client.installationToken(owner, name);
      if (installation.status !== "ok") {
        return installation.status === "denied"
          ? { status: "unavailable", message: `The GitHub App can no longer see ${owner}/${name}.` }
          : installation;
      }
      const user = await client.request(`/users/${encodeURIComponent(login)}`, installation.token, "GET");
      if (user.status === 404) {
        return { status: "not_found" };
      }
      if (!user.ok || typeof user.body !== "object" || user.body === null) {
        return { status: "unavailable", message: "GitHub did not answer the account lookup." };
      }
      const body = user.body as Record<string, unknown>;
      if (body.type !== "User" || typeof body.id !== "number" || typeof body.login !== "string") {
        return { status: "not_found" };
      }
      return { status: "found", id: body.id, login: body.login };
    } catch (error) {
      return { status: "unavailable", message: error instanceof Error ? error.message : "GitHub App authentication failed." };
    }
  };
}

function readNumberId(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "number") {
    return null;
  }
  return body.id;
}
