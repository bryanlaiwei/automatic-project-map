// Turns new session messages into session.started and session.content_added events.
// Long messages are shortened so one upload stays under the API body limit.

import { normalizedEventSchema, SCHEMA_VERSION, sessionContentEventId, type NormalizedEvent, type SessionMessage } from "@apm/shared";
import type { SessionAgentId } from "./contract/adapter.js";

/** Keeps every content event well under the API's per-request body limit. */
export const contentEventLimits = {
  messages: 200,
  bytes: 256 * 1024,
  messageChars: 32 * 1024,
};

const shortenedMarker = "\n[message shortened by the local helper]";

export function buildEvents(input: {
  projectId: string;
  agent: SessionAgentId;
  sessionId: string;
  createdAt: string;
  sourceVersion: string | null;
  records: SessionMessage[];
  includeStarted: boolean;
}): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (input.includeStarted) {
    const startedId = `${input.agent}:${input.sessionId}:started`;
    events.push(
      normalizedEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: startedId,
        sourceKey: startedId,
        projectId: input.projectId,
        source: input.agent,
        occurredAt: input.createdAt,
        details: {
          kind: "session.started",
          sessionId: input.sessionId,
          createdAt: input.createdAt,
          sourceVersion: input.sourceVersion,
        },
      }),
    );
  }
  for (const records of contentGroups(input.records)) {
    const first = records[0];
    if (!first) {
      continue;
    }
    const contentId = sessionContentEventId(input.agent, input.sessionId, records);
    events.push(
      normalizedEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: contentId,
        sourceKey: contentId,
        projectId: input.projectId,
        source: input.agent,
        occurredAt: first.occurredAt,
        details: {
          kind: "session.content_added",
          sessionId: input.sessionId,
          createdAt: input.createdAt,
          sourceVersion: input.sourceVersion,
          recordIds: records.map((record) => record.id),
          messages: records,
        },
      }),
    );
  }
  return events;
}

export function contentGroups(records: readonly SessionMessage[]): SessionMessage[][] {
  const groups: SessionMessage[][] = [];
  let current: SessionMessage[] = [];
  let bytes = 0;
  for (const record of records) {
    const message = shortenMessage(record);
    const size = Buffer.byteLength(JSON.stringify(message));
    if (current.length > 0 && (current.length >= contentEventLimits.messages || bytes + size > contentEventLimits.bytes)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(message);
    bytes += size;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** Postgres cannot store NUL characters in text, so one would make the server refuse the whole upload. */
function shortenMessage(record: SessionMessage): SessionMessage {
  const text = record.text.includes("\u0000") ? record.text.replaceAll("\u0000", "") : record.text;
  if (text.length <= contentEventLimits.messageChars) {
    return text === record.text ? record : { ...record, text };
  }
  return { ...record, text: text.slice(0, contentEventLimits.messageChars - shortenedMarker.length) + shortenedMarker };
}
