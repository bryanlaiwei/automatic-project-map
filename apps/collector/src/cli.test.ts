import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/codex/session.jsonl");
const trackingStartedAt = "2026-09-24T12:00:00.000Z";

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
  it("parses a session and prints whether it is eligible", async () => {
    const output = capture();
    const result = await runCli([fixture, trackingStartedAt, "codex", "/Projects/my-app"], {}, output.io);
    expect(result.exitCode).toBe(0);
    expect(output.logs.join("\n")).toContain('"eligible"');
  });
});
