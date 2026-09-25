import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/codex/session.jsonl");
const projectId = "22222222-2222-4222-8222-222222222222";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";
const secret = "supabase-access-token-do-not-print";

function writableSession(): { filePath: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apm-cli-")));
  const filePath = join(root, "session.jsonl");
  const createdAt = "2999-01-01T00:00:00.000Z";
  writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: createdAt,
      type: "session_meta",
      payload: { id: "cli-session", timestamp: createdAt, cwd: root, cli_version: "0.130.0" },
    })}\n${JSON.stringify({
      timestamp: "2999-01-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello from the cli" },
    })}\n`,
  );
  return { filePath, root };
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

describe("collector CLI", () => {
  it("parses a session without uploading or printing a token", async () => {
    const output = capture();
    let called = false;
    const result = await runCli(
      [fixture, trackingStartedAt, "codex", "/Projects/my-app"],
      { APM_ACCESS_TOKEN: secret },
      output.io,
      async () => {
        called = true;
        return new Response("{}", { status: 500 });
      },
    );
    expect(result.exitCode).toBe(0);
    expect(called).toBe(false);
    expect(output.logs.join("\n")).toContain('"eligible"');
    expect(output.logs.join("\n")).not.toContain(secret);
    expect(output.errors.join("\n")).not.toContain(secret);
  });

  it("refuses to upload when APM_ACCESS_TOKEN is missing and rejects a token argument", async () => {
    const missing = capture();
    const missingResult = await runCli(
      ["upload", fixture, "codex", projectId, trackingStartedAt, "/Projects/my-app"],
      {},
      missing.io,
    );
    expect(missingResult.exitCode).toBe(1);
    expect(missing.errors.join("\n")).toMatch(/APM_ACCESS_TOKEN is missing/);

    const flagged = capture();
    const flaggedResult = await runCli(
      ["upload", fixture, "codex", projectId, trackingStartedAt, "/Projects/my-app", "--token", secret],
      { APM_ACCESS_TOKEN: secret },
      flagged.io,
    );
    expect(flaggedResult.exitCode).toBe(1);
    expect(flagged.errors.join("\n")).toMatch(/Do not pass the access token/);
    expect(flagged.errors.join("\n")).not.toContain(secret);
  });

  it("uploads missing chunks and reports how many were already on the server", async () => {
    const session = writableSession();
    const output = capture();
    const calls: string[] = [];
    const result = await runCli(
      ["upload", "--api-url", "http://127.0.0.1:4999", session.filePath, "codex", projectId, trackingStartedAt, session.root],
      { APM_ACCESS_TOKEN: secret },
      output.io,
      async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toBe(`Bearer ${secret}`);
        if (method === "GET") {
          return Response.json({
            acknowledged: [],
            chunkCount: null,
            contentSha256: null,
            complete: false,
            stored: null,
            reason: null,
            eventsStored: null,
          });
        }
        return Response.json(
          {
            acknowledged: [0],
            chunkCount: 1,
            contentSha256: "ignored-by-client",
            complete: true,
            stored: true,
            reason: null,
            eventsStored: 2,
          },
          { status: 202 },
        );
      },
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.startsWith("POST http://127.0.0.1:4999/ingest/sessions/chunks"))).toBe(true);
    const summary = output.logs.join("\n");
    expect(summary).toMatch(/bytes: \d+/);
    expect(summary).toContain("chunks: 1");
    expect(summary).toContain("already on server: 0");
    expect(summary).toContain("newly sent: 1");
    expect(summary).toContain("complete: true");
    expect(summary).toContain("stored: true");
    expect(summary).toContain("reason: null");
    expect(summary).toContain("eventsStored: 2");
    expect(summary).not.toContain(secret);
  });

  it("does not send chunks that the server already acknowledged", async () => {
    const session = writableSession();
    const output = capture();
    const methods: string[] = [];
    const result = await runCli(
      ["upload", session.filePath, "codex", projectId, trackingStartedAt, session.root],
      { APM_ACCESS_TOKEN: secret, APM_API_URL: "http://127.0.0.1:4000" },
      output.io,
      async (input, init) => {
        methods.push(init?.method ?? "GET");
        const hash = new URL(String(input)).searchParams.get("contentSha256");
        return Response.json({
          acknowledged: [0],
          chunkCount: 1,
          contentSha256: hash,
          complete: true,
          stored: true,
          reason: null,
          eventsStored: 2,
        });
      },
    );
    expect(result.exitCode).toBe(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
    expect(output.logs.join("\n")).toContain("already on server: 1");
    expect(output.logs.join("\n")).toContain("newly sent: 0");
  });

  it("fails when the server reports a reassembled hash mismatch", async () => {
    const session = writableSession();
    const output = capture();
    const result = await runCli(
      ["upload", session.filePath, "codex", projectId, trackingStartedAt, session.root],
      { APM_ACCESS_TOKEN: secret },
      output.io,
      async (_input, init) => {
        if ((init?.method ?? "GET") === "GET") {
          return Response.json({
            acknowledged: [],
            chunkCount: null,
            contentSha256: null,
            complete: false,
            stored: null,
            reason: null,
            eventsStored: null,
          });
        }
        return Response.json(
          { error: "Reassembled session does not match the declared content hash. Reset the upload and send it again." },
          { status: 400 },
        );
      },
    );
    expect(result.exitCode).toBe(1);
    const errors = output.errors.join("\n");
    expect(errors).toMatch(/content hash/);
    expect(errors).toMatch(/Upload failed/);
    expect(errors).not.toContain(secret);
    expect(output.logs.join("\n")).not.toContain("complete: true");
  });
});
