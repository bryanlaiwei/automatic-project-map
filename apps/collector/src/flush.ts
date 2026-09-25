import { SESSION_CHUNK_REQUEST_LIMIT_BYTES, type NormalizedEvent } from "@apm/shared";
import type { LocalDb, OutboxEvent } from "./local-db.js";

export type IngestAck = {
  acknowledged: string[];
  rejected: Array<{ eventId: string; reason: string }>;
};

export type EventUploadTransport = {
  send(input: { projectId: string; events: NormalizedEvent[] }): Promise<IngestAck>;
};

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** The API accepts at most 100 events and a 512 KiB JSON body per request. */
export const uploadBatchLimits = {
  events: 100,
  bytes: SESSION_CHUNK_REQUEST_LIMIT_BYTES - 64 * 1024,
};

export type FlushResult = {
  acknowledged: string[];
  rejected: Array<{ eventId: string; reason: string }>;
  failed: number;
  error: string | null;
  unauthorized: boolean;
};

export async function flushOutbox(
  db: LocalDb,
  transport: EventUploadTransport,
  options: { projectId?: string } = {},
): Promise<FlushResult> {
  const all = db.pendingEvents();
  const result: FlushResult = { acknowledged: [], rejected: [], failed: 0, error: null, unauthorized: false };
  if (all.length === 0) {
    return result;
  }
  const projectId = options.projectId ?? all[0]?.projectId;
  if (!projectId) {
    return result;
  }
  if (!options.projectId && all.some((item) => item.projectId !== projectId)) {
    throw new Error("The local queue contains events for more than one project.");
  }
  const pending = all.filter((item) => item.projectId === projectId);
  const batches = uploadBatches(pending);

  for (const [index, batch] of batches.entries()) {
    const ids = new Set(batch.map((item) => item.eventId));
    try {
      const ack = await transport.send({ projectId, events: batch.map((item) => item.event) });
      const acknowledged = ack.acknowledged.filter((id) => ids.has(id));
      db.acknowledge(acknowledged);
      result.acknowledged.push(...acknowledged);
      const rejected = ack.rejected.filter((item) => ids.has(item.eventId));
      db.discard(rejected.map((item) => item.eventId));
      result.rejected.push(...rejected);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      const unsent = batches.slice(index).flat();
      db.recordFailure(unsent.map((item) => item.eventId), message);
      result.failed = unsent.length;
      result.error = message;
      result.unauthorized = error instanceof UploadError && error.status === 401;
      return result;
    }
  }
  return result;
}

/** Splits the queue into requests the API will accept, keeping queue order. */
export function uploadBatches(pending: OutboxEvent[]): OutboxEvent[][] {
  const batches: OutboxEvent[][] = [];
  let current: OutboxEvent[] = [];
  let bytes = 0;
  for (const item of pending) {
    const size = Buffer.byteLength(JSON.stringify(item.event)) + 1;
    if (current.length > 0 && (current.length >= uploadBatchLimits.events || bytes + size > uploadBatchLimits.bytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export function createFetchEventTransport(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): EventUploadTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    async send(body) {
      const response = await fetchImpl(`${baseUrl}/ingest/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message =
          typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Event upload failed (${response.status}).`;
        throw new UploadError(message, response.status);
      }
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { acknowledged?: unknown }).acknowledged)) {
        throw new UploadError("Event upload response was invalid.", response.status);
      }
      const record = payload as { acknowledged: unknown[]; rejected?: unknown };
      return {
        acknowledged: record.acknowledged.filter((id): id is string => typeof id === "string"),
        rejected: Array.isArray(record.rejected)
          ? record.rejected.flatMap((item) => {
              if (typeof item !== "object" || item === null || !("eventId" in item) || !("reason" in item)) {
                return [];
              }
              if (typeof item.eventId !== "string" || typeof item.reason !== "string") {
                return [];
              }
              return [{ eventId: item.eventId, reason: item.reason }];
            })
          : [],
      };
    },
  };
}
