// Turns new session messages into session.started and session.content_added events.
// A long message is split across rows so each stored piece stays within evidenceRowChars.

import {
  evidenceRowChars,
  normalizedEventSchema,
  SCHEMA_VERSION,
  sessionContentEventId,
  type NormalizedEvent,
  type SessionMessage,
} from "@apm/shared";
import type { SessionAgentId } from "./contract/adapter.js";

/** Keeps every content event well under the API's per-request body limit. */
export const contentEventLimits = {
  messages: 200,
  bytes: 256 * 1024,
};

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

function contentGroups(records: readonly SessionMessage[]): SessionMessage[][] {
  const groups: SessionMessage[][] = [];
  let current: SessionMessage[] = [];
  let chars = 0;
  let bytes = 0;
  for (const record of records) {
    for (const message of splitMessage(record)) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (
        current.length > 0 &&
        (current.length >= contentEventLimits.messages ||
          bytes + size > contentEventLimits.bytes ||
          chars + message.text.length > evidenceRowChars)
      ) {
        groups.push(current);
        current = [];
        chars = 0;
        bytes = 0;
      }
      current.push(message);
      chars += message.text.length;
      bytes += size;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** Postgres cannot store NUL characters in text, so one would make the server refuse the whole upload. */
function splitMessage(record: SessionMessage): SessionMessage[] {
  const text = record.text.includes("\u0000") ? record.text.replaceAll("\u0000", "") : record.text;
  if (text.length <= evidenceRowChars) {
    return [text === record.text ? record : { ...record, text }];
  }
  const pieces: SessionMessage[] = [];
  for (let offset = 0; offset < text.length; offset += evidenceRowChars) {
    pieces.push({
      ...record,
      id: `${record.id}:${offset}`,
      text: text.slice(offset, offset + evidenceRowChars),
    });
  }
  return pieces;
}
