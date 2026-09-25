import { describe, expect, it } from "vitest";
import { normalizedEventSchema, SCHEMA_VERSION } from "./index.js";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("normalized events", () => {
  it("accepts a GitHub pull request update", () => {
    const parsed = normalizedEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: "github:delivery-1",
      sourceKey: "github:pr:10:2026-09-24T12:00:00.000Z",
      projectId,
      source: "github",
      occurredAt: "2026-09-24T12:00:00.000Z",
      details: {
        kind: "pr.updated",
        repositoryId: 10,
        pullRequestId: 20,
        number: 3,
        title: "Add reset email validation",
        body: "",
        url: "https://github.com/acme/app/pull/3",
        draft: false,
        state: "open",
        merged: false,
        headSha: "abc123",
        updatedAt: "2026-09-24T12:00:00.000Z",
      },
    });

    expect(parsed.details.kind).toBe("pr.updated");
  });

  it("rejects a session event that claims to come from GitHub", () => {
    const result = normalizedEventSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      eventId: "bad",
      sourceKey: "bad",
      projectId,
      source: "github",
      occurredAt: "2026-09-24T12:00:00.000Z",
      details: {
        kind: "session.started",
        sessionId: "s1",
        createdAt: "2026-09-24T12:00:00.000Z",
        sourceVersion: null,
      },
    });

    expect(result.success).toBe(false);
  });
});
