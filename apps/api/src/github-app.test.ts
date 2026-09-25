import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubRepositoryAccessCheck } from "./github-app.js";

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
    const result = await check({ owner: "acme", name: "app", repoId: 9 });
    expect(result.status).toBe("not_configured");
    if (result.status === "not_configured") {
      expect(result.message).toMatch(/GITHUB_APP_ID/);
      expect(result.message).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    }
    expect(called).toBe(false);
  });

  it("accepts a repository only when the installation can see that numeric id", async () => {
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
        return jsonResponse(200, { id: 99, full_name: "acme/app" });
      },
    });

    await expect(check({ owner: "acme", name: "app", repoId: 99 })).resolves.toEqual({ status: "accessible" });
    await expect(check({ owner: "acme", name: "app", repoId: 100 })).resolves.toEqual({ status: "denied" });
    expect(seen.some((call) => call.includes("/repos/acme/app/installation"))).toBe(true);
  });

  it("denies a repository the App is not installed on", async () => {
    const check = createGithubRepositoryAccessCheck({
      appId: "12345",
      privateKey: privateKey,
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    });
    await expect(check({ owner: "acme", name: "missing", repoId: 5 })).resolves.toEqual({ status: "denied" });
  });
});
