import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubEnricher } from "./github-enrich.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const pull = {
  id: 1,
  number: 4,
  title: "Add reset email",
  body: "",
  html_url: "https://github.com/acme/app/pull/4",
  draft: false,
  state: "open",
  merged_at: null,
  updated_at: "2026-09-25T12:00:00Z",
  head: { sha: "abc123" },
};

describe("GitHub enricher", () => {
  it("returns null instead of throwing when GitHub cannot be reached", async () => {
    const enricher = createGithubEnricher({
      appId: "1",
      privateKey,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/installation")) {
          return jsonResponse(200, { id: 7 });
        }
        if (String(url).includes("/access_tokens")) {
          return jsonResponse(201, { token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" });
        }
        throw new TypeError("fetch failed");
      },
    });
    await expect(enricher.enrichPullRequest("acme", "app", 4)).resolves.toBeNull();
    await expect(enricher.enrichWorkflowRun("acme", "app", 9)).resolves.toBeNull();
  });

  it("reuses an installation token until it is close to expiring", async () => {
    let now = Date.parse("2026-09-25T12:00:00Z");
    let tokenRequests = 0;
    const enricher = createGithubEnricher({
      appId: "1",
      privateKey,
      now: () => now,
      fetchImpl: async (url) => {
        const path = String(url);
        if (path.endsWith("/installation")) {
          return jsonResponse(200, { id: 7 });
        }
        if (path.includes("/access_tokens")) {
          tokenRequests += 1;
          return jsonResponse(201, { token: `ghs_${tokenRequests}`, expires_at: new Date(now + 60 * 60_000).toISOString() });
        }
        if (path.endsWith("/pulls/4")) {
          return jsonResponse(200, pull);
        }
        return jsonResponse(200, []);
      },
    });
    expect((await enricher.enrichPullRequest("acme", "app", 4))?.title).toBe("Add reset email");
    await enricher.enrichPullRequest("acme", "app", 4);
    expect(tokenRequests).toBe(1);
    now += 56 * 60_000;
    await enricher.enrichPullRequest("acme", "app", 4);
    expect(tokenRequests).toBe(2);
  });
});
