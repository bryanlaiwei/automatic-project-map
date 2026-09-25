import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeCodeSession } from "./adapters/claude-code.js";
import { parseCodexSession } from "./adapters/codex.js";
import { parseCursorSession } from "./adapters/cursor.js";
import { eventsFromParsedSession } from "./collect.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const projectId = "22222222-2222-4222-8222-222222222222";
const trackingStartedAt = "2026-09-24T12:00:00.000Z";

function collect(agent: "codex" | "cursor" | "claude_code", parsed: ReturnType<typeof parseCodexSession>, roots: string[]) {
  return eventsFromParsedSession({
    agent,
    parsed,
    projectId,
    trackingStartedAt,
    selectedRoots: roots,
    resolvePaths: false,
  });
}

describe("session samples", () => {
  it("turns an eligible Codex sample into events and drops hidden reasoning", () => {
    const result = collect("codex", parseCodexSession(join(fixtures, "codex/session.jsonl")), ["/Projects/my-app"]);
    expect(result.eligible).toBe(true);
    expect(result.events.map((event) => event.details.kind)).toEqual([
      "session.started",
      "session.content_added",
    ]);
    const content = result.events[1];
    if (content?.details.kind !== "session.content_added") {
      throw new Error("expected content");
    }
    expect(content.details.messages.map((message) => message.text).join(" ")).toContain("reset-email");
    expect(content.details.messages.map((message) => message.text).join(" ")).not.toContain("hidden");
  });

  it("reads Claude Code and skips tool output", () => {
    const result = collect(
      "claude_code",
      parseClaudeCodeSession(join(fixtures, "claude-code/session.jsonl")),
      ["/Projects/my-app"],
    );
    expect(result.eligible).toBe(true);
    const content = result.events[1];
    if (content?.details.kind !== "session.content_added") {
      throw new Error("expected content");
    }
    expect(content.details.messages[1]?.text).toContain("[tool output omitted]");
    expect(content.details.messages[1]?.text).not.toContain("large log");
  });

  it("reads a Cursor sample only when session.json has a creation time", () => {
    const parsed = parseCursorSession(join(fixtures, "cursor"));
    const result = collect("cursor", parsed, ["/Projects/my-app"]);
    expect(result.eligible).toBe(true);
    expect(result.events[0]?.source).toBe("cursor");
  });

  it("excludes a session created before tracking and a nonmatching folder", () => {
    const parsed = parseCodexSession(join(fixtures, "codex/session.jsonl"));
    const tooEarly = collect("codex", { ...parsed, createdAt: "2026-09-24T11:00:00.000Z" }, ["/Projects/my-app"]);
    expect(tooEarly).toMatchObject({ eligible: false, reason: "created_before_tracking", events: [] });

    const otherFolder = collect("codex", parsed, ["/Projects/other-app"]);
    expect(otherFolder).toMatchObject({ eligible: false, reason: "folder_not_selected", events: [] });

    const undated = collect("codex", { ...parsed, createdAt: null }, ["/Projects/my-app"]);
    expect(undated).toMatchObject({ eligible: false, reason: "missing_creation_time", events: [] });
  });
});
