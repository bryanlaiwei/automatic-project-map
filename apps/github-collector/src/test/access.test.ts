import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubAccountLookup, createGithubRepositoryAccessCheck } from "../access.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub App repository check", () => {
  it("fails closed when the private key is not configured", async () => {
    let called = false;
    const check = createGithubRepositoryAccessCheck({
      appId: "",
      privateKey: "",
      fetchImpl: async () => {
        called = true;
        return jsonResponse(500, {});
      },
    });
    const result = await check({ owner: "acme", name: "app", repoId: 9, login: "alice" });
    expect(result.status).toBe("not_configured");
    if (result.status === "not_configured") {
      expect(result.message).toMatch(/GITHUB_APP_ID/);
      expect(result.message).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    }
    expect(called).toBe(false);
  });

  it("accepts a repository only when the installation can see that numeric id, and reports the id when none is given", async () => {
    const seen: string[] = [];
    const check = createGithubRepositoryAccessCheck({
      appId: "12345",
      privateKey: privateKey,
      fetchImpl: async (input, init) => {
        const url = String(input);
        seen.push(`${init?.method ?? "GET"} ${url}`);
        const header = new Headers(init?.headers).get("authorization") ?? "";
        expect(header.startsWith("Bearer ")).toBe(true);
        if (url.endsWith("/installation")) {
          const token = header.slice("Bearer ".length);
          const payloadPart = token.split(".")[1] ?? "";
          const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { iss?: string };
          expect(payload.iss).toBe("12345");
          return jsonResponse(200, { id: 77 });
        }
        if (url.endsWith("/access_tokens")) {
          return jsonResponse(201, { token: "ghs_test" });
        }
        if (url.endsWith("/collaborators/alice/permission")) {
          return jsonResponse(200, { permission: "admin" });
        }
        return jsonResponse(200, { id: 99, full_name: "acme/app" });
      },
    });

    await expect(check({ owner: "acme", name: "app", repoId: 99, login: "alice" })).resolves.toEqual({ status: "accessible", repoId: 99 });
    await expect(check({ owner: "acme", name: "app", repoId: 100, login: "alice" })).resolves.toEqual({ status: "denied" });
    await expect(check({ owner: "acme", name: "app", login: "alice" })).resolves.toEqual({ status: "accessible", repoId: 99 });
    expect(seen.some((call) => call.includes("/repos/acme/app/installation"))).toBe(true);
  });

  it("refuses someone who cannot push to the repository, or who did not sign in with GitHub", async () => {
    const check = createGithubRepositoryAccessCheck({
      appId: "12345",
      privateKey: privateKey,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/installation")) {
          return jsonResponse(200, { id: 77 });
        }
        if (url.endsWith("/access_tokens")) {
          return jsonResponse(201, { token: "ghs_test" });
        }
        if (url.endsWith("/collaborators/reader/permission")) {
          return jsonResponse(200, { permission: "read" });
        }
        if (url.endsWith("/collaborators/stranger/permission")) {
          return jsonResponse(404, { message: "Not Found" });
        }
        return jsonResponse(200, { id: 99, full_name: "acme/app" });
      },
    });
    await expect(check({ owner: "acme", name: "app", login: "reader" })).resolves.toMatchObject({ status: "not_permitted" });
    await expect(check({ owner: "acme", name: "app", login: "stranger" })).resolves.toMatchObject({ status: "not_permitted" });
    await expect(check({ owner: "acme", name: "app", login: null })).resolves.toMatchObject({ status: "not_permitted" });
  });

  it("looks up people by username and refuses organizations and unknown names", async () => {
    const lookup = createGithubAccountLookup({
      appId: "12345",
      privateKey: privateKey,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/installation")) {
          return jsonResponse(200, { id: 77 });
        }
        if (url.endsWith("/access_tokens")) {
          return jsonResponse(201, { token: "ghs_test" });
        }
        if (url.endsWith("/users/octo")) {
          return jsonResponse(200, { id: 583231, login: "Octo", type: "User" });
        }
        if (url.endsWith("/users/acme")) {
          return jsonResponse(200, { id: 9, login: "acme", type: "Organization" });
        }
        return jsonResponse(404, { message: "Not Found" });
      },
    });
    await expect(lookup({ owner: "acme", name: "app", login: "octo" })).resolves.toEqual({ status: "found", id: 583231, login: "Octo" });
    await expect(lookup({ owner: "acme", name: "app", login: "acme" })).resolves.toEqual({ status: "not_found" });
    await expect(lookup({ owner: "acme", name: "app", login: "nobody" })).resolves.toEqual({ status: "not_found" });
  });

  it("denies a repository the App is not installed on", async () => {
    const check = createGithubRepositoryAccessCheck({
      appId: "12345",
      privateKey: privateKey,
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    });
    await expect(check({ owner: "acme", name: "missing", repoId: 5, login: "alice" })).resolves.toEqual({ status: "denied" });
  });
});
