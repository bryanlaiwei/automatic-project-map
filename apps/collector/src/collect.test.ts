import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeCodeSession } from "./adapters/claude-code.js";
import { parseCodexSession, parseJsonLines } from "./adapters/codex.js";
import { parseCursorSession } from "./adapters/cursor.js";
import { collectSession, eventsFromParsedSession } from "./collect.js";

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

  it("matches a selected root when the session folder is reached through a symlink", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "apm-real-")));
    const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "apm-link-")));
    const link = join(linkParent, "alias");
    symlinkSync(real, link);
    const createdAt = "2026-09-24T18:00:00.000Z";
    const filePath = join(real, "session.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: createdAt,
        type: "session_meta",
        payload: { id: "symlink-session", timestamp: createdAt, cwd: link, cli_version: "0.130.0" },
      })}\n`,
    );
    const result = collectSession({
      agent: "codex",
      filePath,
      projectId,
      trackingStartedAt,
      selectedRoots: [link],
    });
    expect(result).toMatchObject({ eligible: true, reason: null });
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

  it("keeps a later content upload distinct from an identical retry", () => {
    const parsed = parseCodexSession(join(fixtures, "codex/session.jsonl"));
    const first = collect("codex", parsed, ["/Projects/my-app"]);
    const again = collect("codex", parsed, ["/Projects/my-app"]);
    expect(again.events.map((event) => event.eventId)).toEqual(first.events.map((event) => event.eventId));

    const extra = {
      ...parsed,
      records: [
        ...parsed.records,
        {
          id: "later",
          role: "user" as const,
          text: "Follow-up that must be kept",
          occurredAt: "2026-09-24T18:05:00.000Z",
        },
      ],
    };
    const second = collect("codex", extra, ["/Projects/my-app"]);
    const firstContent = first.events.find((event) => event.details.kind === "session.content_added");
    const secondContent = second.events.find((event) => event.details.kind === "session.content_added");
    expect(secondContent?.eventId).not.toBe(firstContent?.eventId);
    if (secondContent?.details.kind !== "session.content_added") {
      throw new Error("expected content");
    }
    expect(secondContent.details.messages.map((message) => message.text)).toContain("Follow-up that must be kept");
  });

  it("defers a half-written final line and still reads a finished session", () => {
    const finished = '{"type":"session_meta","payload":{"id":"s","timestamp":"2026-09-24T18:00:00.000Z","cwd":"/Projects/my-app"}}\n{"type":"event_msg","timestamp":"2026-09-24T18:00:01.000Z","payload":{"type":"user_message","message":"hello"}}';
    expect(parseJsonLines(finished)).toHaveLength(2);

    const partial = `${finished}\n{"type":"event_msg","timestamp":"2026-09-24T18:00:02.000Z","payload":`;
    expect(parseJsonLines(partial)).toHaveLength(2);
    expect(() => parseJsonLines(`${partial}\n`)).toThrow();

    const directory = mkdtempSync(join(tmpdir(), "session-"));
    const filePath = join(directory, "session.jsonl");
    writeFileSync(filePath, partial);
    const parsed = parseCodexSession(filePath);
    expect(parsed.sessionId).toBe("s");
    expect(parsed.records.map((record) => record.text)).toEqual(["hello"]);
  });
});
