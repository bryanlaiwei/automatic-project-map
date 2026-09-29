import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GitHub webhooks", () => {
  it("refuses to start the API with an empty webhook secret", () => {
    expect(() =>
      createApp({
        pool: {} as Pool,
        webhookSecret: "",
        verifyUser: async () => null,
        verifyRepositoryAccess: async () => ({ status: "accessible" }),
      }),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });
});
