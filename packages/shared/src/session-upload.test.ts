import { describe, expect, it } from "vitest";
import {
  buildSessionEvents,
  joinSessionBytes,
  serializeIngestedSession,
  sessionContentEventId,
  sha256Hex,
  splitSessionBytes,
  SESSION_CHUNK_BYTES,
  SESSION_CHUNK_REQUEST_LIMIT_BYTES,
} from "./session-upload.js";

const projectId = "11111111-1111-4111-8111-111111111111";

function session(records: Array<{ id: string; text: string }>) {
  return {
    source: "codex" as const,
    sessionId: "sess-1",
    createdAt: "2999-01-01T00:00:00.000Z",
    workingFolder: "/Projects/my-app",
    selectedRoots: ["/Projects/my-app"],
    sourceVersion: "0.130.0",
    records: records.map((record) => ({
      id: record.id,
      role: "user" as const,
      text: record.text,
      occurredAt: "2999-01-01T00:00:01.000Z",
    })),
  };
}

describe("session chunks", () => {
  it("joins chunks back to the original bytes, including a split multibyte character", () => {
    const payload = `café ${"a".repeat(50)} "quotes"\n`;
    const chunks = splitSessionBytes(payload, 4);
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinSessionBytes(chunks)).toBe(payload);
    expect(sha256Hex(Buffer.concat(chunks))).toBe(sha256Hex(Buffer.from(payload, "utf8")));
  });

  it("keeps a max-size chunk request under the per-request limit", () => {
    const chunk = Buffer.alloc(SESSION_CHUNK_BYTES, 255);
    const body = JSON.stringify({
      projectId: "11111111-1111-4111-8111-111111111111",
      source: "codex",
      sessionId: "s",
      chunkIndex: 0,
      chunkCount: 2,
      contentSha256: "a".repeat(64),
      payload: chunk.toString("base64"),
    });
    expect(Buffer.byteLength(body)).toBeLessThan(SESSION_CHUNK_REQUEST_LIMIT_BYTES);
  });

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

    const events = buildSessionEvents({ projectId, session: second });
    expect(events.map((event) => event.details.kind)).toEqual(["session.started", "session.content_added"]);
    expect(events[1]?.eventId).toBe(secondId);
    expect(JSON.stringify(events)).not.toContain("/Projects/my-app");
  });

  it("serializes a session without dropping fields the server reassembles", () => {
    const original = session([{ id: "1", text: "exact" }]);
    const serialized = serializeIngestedSession(original);
    expect(JSON.parse(serialized)).toEqual(original);
  });
});
