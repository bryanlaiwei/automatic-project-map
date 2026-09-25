import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGithubDelivery, verifyGithubSignature } from "./github.js";

const projectId = "33333333-3333-4333-8333-333333333333";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub webhooks", () => {
  it("checks the signature against the raw body", () => {
    const body = Buffer.from('{"ok":true}');
    expect(verifyGithubSignature(body, sign(body.toString(), "secret"), "secret")).toBe(true);
    expect(verifyGithubSignature(body, sign(body.toString(), "other"), "secret")).toBe(false);
  });

  it("turns a pull request payload into one event", () => {
    const result = normalizeGithubDelivery({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      projectId,
      receivedAt: "2026-09-24T20:00:00.000Z",
      payload: {
        repository: { id: 99 },
        pull_request: {
          id: 5,
          number: 8,
          title: "Validate reset email",
          body: "details",
          html_url: "https://github.com/acme/app/pull/8",
          draft: true,
          state: "open",
          merged_at: null,
          updated_at: "2026-09-24T19:00:00.000Z",
          head: { sha: "abc" },
        },
      },
    });
    expect(result.status).toBe("events");
    if (result.status !== "events") {
      return;
    }
    expect(result.events[0]?.details.kind).toBe("pr.updated");
  });

  it("turns a workflow run into an event and ignores a ping", () => {
    const run = normalizeGithubDelivery({
      eventName: "workflow_run",
      deliveryId: "delivery-2",
      projectId,
      receivedAt: "2026-09-24T20:00:00.000Z",
      payload: {
        repository: { id: 99 },
        workflow_run: {
          id: 7,
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
          head_sha: "def",
          html_url: "https://github.com/acme/app/actions/runs/7",
          updated_at: "2026-09-24T19:30:00.000Z",
          pull_requests: [{ number: 8 }],
        },
      },
    });
    expect(run.status).toBe("events");
    expect(normalizeGithubDelivery({
      eventName: "ping",
      deliveryId: "delivery-3",
      projectId,
      receivedAt: "2026-09-24T20:00:00.000Z",
      payload: { zen: "ok" },
    })).toEqual({ status: "ignore", note: "ping" });
  });
});
