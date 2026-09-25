import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizedEventSchema, SCHEMA_VERSION, type NormalizedEvent, type SessionMessage } from "./events.js";

/** Raw UTF-8 bytes per chunk. The JSON request that carries a chunk stays under the per-request limit. */
export const SESSION_CHUNK_BYTES = 96 * 1024;

/** Express JSON limit for one chunk request. This is not a limit on the whole session. */
export const SESSION_CHUNK_REQUEST_LIMIT_BYTES = 512 * 1024;

export const sessionAgents = ["codex", "cursor", "claude_code"] as const;
export const sessionAgentSchema = z.enum(sessionAgents);
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

export const ingestedSessionRecordSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  occurredAt: z.string().datetime(),
});

export const ingestedSessionSchema = z.object({
  source: sessionAgentSchema,
  sessionId: z.string().min(1),
  createdAt: z.string().datetime().nullable(),
  workingFolder: z.string().nullable(),
  selectedRoots: z.array(z.string()),
  sourceVersion: z.string().nullable(),
  records: z.array(ingestedSessionRecordSchema),
});

export type IngestedSession = z.infer<typeof ingestedSessionSchema>;

export function serializeIngestedSession(session: IngestedSession): string {
  return JSON.stringify({
    source: session.source,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    workingFolder: session.workingFolder,
    selectedRoots: session.selectedRoots,
    sourceVersion: session.sourceVersion,
    records: session.records.map((record) => ({
      id: record.id,
      role: record.role,
      text: record.text,
      occurredAt: record.occurredAt,
    })),
  });
}

export function splitSessionBytes(payload: string, chunkBytes = SESSION_CHUNK_BYTES): Buffer[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("Chunk size must be a positive integer.");
  }
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.length === 0) {
    return [Buffer.alloc(0)];
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, bytes.length);
    chunks.push(Buffer.from(bytes.subarray(offset, end)));
  }
  return chunks;
}

export function joinSessionBytes(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Identity of one content upload. The digest covers record id, role, time, and text in order,
 * so an identical retry keeps the same id and a later upload that adds or changes records does not.
 */
export function sessionContentEventId(source: string, sessionId: string, records: readonly SessionMessage[]): string {
  const canonical = records
    .map((record) => `${record.id}\u001f${record.role}\u001f${record.occurredAt}\u001f${record.text}`)
    .join("\u001e");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${source}:${sessionId}:content:${digest}`;
}

export function buildSessionEvents(input: { projectId: string; session: IngestedSession }): NormalizedEvent[] {
  const createdAt = input.session.createdAt;
  if (createdAt === null) {
    return [];
  }
  const startedId = `${input.session.source}:${input.session.sessionId}:started`;
  const started = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: startedId,
    sourceKey: startedId,
    projectId: input.projectId,
    source: input.session.source,
    occurredAt: createdAt,
    details: {
      kind: "session.started",
      sessionId: input.session.sessionId,
      createdAt,
      sourceVersion: input.session.sourceVersion,
    },
  });
  const first = input.session.records[0];
  if (!first) {
    return [started];
  }
  const contentId = sessionContentEventId(input.session.source, input.session.sessionId, input.session.records);
  const content = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: contentId,
    sourceKey: contentId,
    projectId: input.projectId,
    source: input.session.source,
    occurredAt: first.occurredAt,
    details: {
      kind: "session.content_added",
      sessionId: input.session.sessionId,
      createdAt,
      sourceVersion: input.session.sourceVersion,
      recordIds: input.session.records.map((record) => record.id),
      messages: input.session.records,
    },
  });
  return [started, content];
}
