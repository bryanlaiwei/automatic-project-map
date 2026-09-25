import { describe, expect, it } from "vitest";
import { serializeIngestedSession, sha256Hex, splitSessionBytes, type IngestedSession } from "@apm/shared";
import { createFetchSessionUploadTransport, uploadSessionChunks, type SessionUploadAck, type SessionUploadTransport } from "./upload.js";

function session(text: string, id = "1"): IngestedSession {
  return {
    source: "codex",
    sessionId: "sess-upload",
    createdAt: "2999-01-01T00:00:00.000Z",
    workingFolder: "/Projects/my-app",
    selectedRoots: ["/Projects/my-app"],
    sourceVersion: "0.130.0",
    records: [{ id, role: "user", text, occurredAt: "2999-01-01T00:00:01.000Z" }],
  };
}

describe("chunked session upload", () => {
  it("resumes after a failed chunk and reassembles the original payload", async () => {
    const original = session(`${"word ".repeat(30)}café`);
    const serialized = serializeIngestedSession(original);
    const stored = new Map<number, Buffer>();
    let failOn = 1;
    const sent: number[] = [];

    const transport: SessionUploadTransport = {
      async status() {
        const pieces = splitSessionBytes(serialized, 24);
        const hash = sha256Hex(Buffer.concat(pieces));
        if (stored.size === 0) {
          return {
            acknowledged: [],
            chunkCount: null,
            contentSha256: null,
            complete: false,
            stored: null,
            reason: null,
            eventsStored: null,
          };
        }
        return {
          acknowledged: [...stored.keys()].sort((left, right) => left - right),
          chunkCount: pieces.length,
          contentSha256: hash,
          complete: false,
          stored: null,
          reason: null,
          eventsStored: null,
        };
      },
      async reset() {
        stored.clear();
      },
      async send(chunk) {
        sent.push(chunk.chunkIndex);
        if (chunk.chunkIndex === failOn) {
          failOn = -1;
          throw new Error("network down");
        }
        stored.set(chunk.chunkIndex, Buffer.from(chunk.payloadBase64, "base64"));
        const pieces = splitSessionBytes(serialized, 24);
        const complete = stored.size === pieces.length;
        const ack: SessionUploadAck = {
          acknowledged: [...stored.keys()].sort((left, right) => left - right),
          chunkCount: pieces.length,
          contentSha256: chunk.contentSha256,
          complete,
          stored: complete ? true : null,
          reason: null,
          eventsStored: complete ? 2 : null,
        };
        return ack;
      },
    };

    await expect(
      uploadSessionChunks({ projectId: "11111111-1111-4111-8111-111111111111", session: original, transport, chunkBytes: 24 }),
    ).rejects.toThrow(/network down/);
    expect(stored.has(0)).toBe(true);
    expect(stored.has(1)).toBe(false);

    const result = await uploadSessionChunks({
      projectId: "11111111-1111-4111-8111-111111111111",
      session: original,
      transport,
      chunkBytes: 24,
    });
    expect(result.complete).toBe(true);
    expect(sent.filter((index) => index === 0)).toEqual([0]);
    const ordered = [...stored.keys()].sort((left, right) => left - right).map((index) => stored.get(index));
    expect(Buffer.concat(ordered.filter((piece): piece is Buffer => piece !== undefined)).toString("utf8")).toBe(serialized);
  });

  it("resets an in-progress upload when the session bytes changed", async () => {
    const original = session("first version of the note");
    let resetCount = 0;
    const sent: number[] = [];
    const transport: SessionUploadTransport = {
      async status() {
        return {
          acknowledged: [0],
          chunkCount: 4,
          contentSha256: "a".repeat(64),
          complete: false,
          stored: null,
          reason: null,
          eventsStored: null,
        };
      },
      async reset() {
        resetCount += 1;
      },
      async send(chunk) {
        sent.push(chunk.chunkIndex);
        const pieces = splitSessionBytes(serializeIngestedSession(original), 32);
        return {
          acknowledged: sent.slice(),
          chunkCount: pieces.length,
          contentSha256: chunk.contentSha256,
          complete: sent.length === pieces.length,
          stored: sent.length === pieces.length ? true : null,
          reason: null,
          eventsStored: sent.length === pieces.length ? 2 : null,
        };
      },
    };

    const result = await uploadSessionChunks({
      projectId: "11111111-1111-4111-8111-111111111111",
      session: original,
      transport,
      chunkBytes: 32,
    });
    expect(resetCount).toBe(1);
    expect(result.complete).toBe(true);
    expect(sent[0]).toBe(0);
  });

  it("asks the API for chunks that are not acknowledged yet", async () => {
    const original = session("resume over http");
    const posts: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET") {
        const hash = new URL(url).searchParams.get("contentSha256") ?? "";
        return Response.json({
          acknowledged: [0],
          chunkCount: splitSessionBytes(serializeIngestedSession(original), 20).length,
          contentSha256: hash,
          complete: false,
          stored: null,
          reason: null,
          eventsStored: null,
        });
      }
      const body = JSON.parse(String(init?.body)) as { chunkIndex: number };
      posts.push(body.chunkIndex);
      const total = splitSessionBytes(serializeIngestedSession(original), 20).length;
      const complete = body.chunkIndex === total - 1;
      return Response.json(
        {
          acknowledged: [0, body.chunkIndex],
          chunkCount: total,
          contentSha256: "ignored",
          complete,
          stored: complete ? true : null,
          reason: null,
          eventsStored: complete ? 2 : null,
        },
        { status: complete ? 202 : 200 },
      );
    };

    const result = await uploadSessionChunks({
      projectId: "11111111-1111-4111-8111-111111111111",
      session: original,
      chunkBytes: 20,
      transport: createFetchSessionUploadTransport({
        baseUrl: "http://127.0.0.1:4000",
        token: "test-user",
        fetchImpl,
      }),
    });
    expect(posts.includes(0)).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.stored).toBe(true);
  });
});
