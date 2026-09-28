// Checks that a content event id stays the same for identical records and changes when a record is added.
import { describe, expect, it } from "vitest";
import { sessionContentEventId } from "./session-content-id.js";

function session(records: Array<{ id: string; text: string }>) {
  return {
    source: "codex" as const,
    sessionId: "sess-1",
    records: records.map((record) => ({
      id: record.id,
      role: "user" as const,
      text: record.text,
      occurredAt: "2999-01-01T00:00:01.000Z",
    })),
  };
}

describe("session content ids", () => {
  it("gives a later record set a new content id and keeps an identical set stable", () => {
    const first = session([{ id: "1", text: "one" }]);
    const second = session([
      { id: "1", text: "one" },
      { id: "2", text: "two" },
    ]);
    const firstId = sessionContentEventId(first.source, first.sessionId, first.records);
    const secondId = sessionContentEventId(second.source, second.sessionId, second.records);
    expect(secondId).not.toBe(firstId);
    expect(sessionContentEventId(first.source, first.sessionId, first.records)).toBe(firstId);
  });
});
