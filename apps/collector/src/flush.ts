import type { NormalizedEvent } from "@apm/shared";
import type { LocalDb } from "./local-db.js";

export type IngestAck = {
  acknowledged: string[];
  rejected: Array<{ eventId: string; reason: string }>;
};

export type EventUploadTransport = {
  send(input: { projectId: string; events: NormalizedEvent[] }): Promise<IngestAck>;
};

export async function flushOutbox(db: LocalDb, transport: EventUploadTransport): Promise<{ acknowledged: string[]; failed: number }> {
  const pending = db.pendingEvents();
  if (pending.length === 0) {
    return { acknowledged: [], failed: 0 };
  }
  const projectId = pending[0]?.projectId;
  if (!projectId || pending.some((item) => item.projectId !== projectId)) {
    throw new Error("The local queue contains events for more than one project.");
  }
  try {
    const ack = await transport.send({ projectId, events: pending.map((item) => item.event) });
    const acknowledged = ack.acknowledged.filter((id) => pending.some((item) => item.eventId === id));
    db.acknowledge(acknowledged);
    const rejectedIds = ack.rejected.map((item) => item.eventId);
    if (rejectedIds.length > 0) {
      db.recordFailure(rejectedIds, ack.rejected.map((item) => item.reason).join(","));
    }
    return { acknowledged, failed: rejectedIds.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed.";
    db.recordFailure(pending.map((item) => item.eventId), message);
    return { acknowledged: [], failed: pending.length };
  }
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
        throw new Error(message);
      }
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { acknowledged?: unknown }).acknowledged)) {
        throw new Error("Event upload response was invalid.");
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
