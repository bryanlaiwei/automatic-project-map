import type { Pool, PoolClient } from "pg";
import { evaluateSessionEligibility, normalizedEventSchema, type NormalizedEvent } from "@apm/shared";
import { insertEventsWith } from "./store.js";

export type IngestRejection = {
  eventId: string;
  reason: string;
};

export type IngestEventsResult = {
  acknowledged: string[];
  rejected: IngestRejection[];
};

export async function ingestEvents(
  pool: Pool,
  input: { projectId: string; events: unknown[] },
): Promise<IngestEventsResult> {
  const project = await pool.query<{ tracking_started_at: Date }>(
    `select tracking_started_at from projects where id = $1`,
    [input.projectId],
  );
  const trackingStartedAt = project.rows[0]?.tracking_started_at;
  if (!trackingStartedAt) {
    return {
      acknowledged: [],
      rejected: input.events.map((_event, index) => ({ eventId: `index:${index}`, reason: "project_not_found" })),
    };
  }

  const accepted: NormalizedEvent[] = [];
  const rejected: IngestRejection[] = [];
  for (const [index, candidate] of input.events.entries()) {
    const parsed = normalizedEventSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({ eventId: eventIdOf(candidate) ?? `index:${index}`, reason: "invalid_event" });
      continue;
    }
    if (parsed.data.projectId !== input.projectId) {
      rejected.push({ eventId: parsed.data.eventId, reason: "project_mismatch" });
      continue;
    }
    const sessionReason = sessionRejection(parsed.data, trackingStartedAt.toISOString());
    if (sessionReason) {
      rejected.push({ eventId: parsed.data.eventId, reason: sessionReason });
      continue;
    }
    accepted.push(parsed.data);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const storedIds = await insertAndList(client, accepted);
    await client.query("commit");
    return { acknowledged: storedIds, rejected };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertAndList(client: PoolClient, events: NormalizedEvent[]): Promise<string[]> {
  if (events.length === 0) {
    return [];
  }
  await insertEventsWith(client, events);
  const ids = events.map((event) => event.eventId);
  const existing = await client.query<{ event_id: string }>(
    `select event_id from normalized_events where event_id = any($1::text[])`,
    [ids],
  );
  const present = new Set(existing.rows.map((row) => row.event_id));
  return ids.filter((id) => present.has(id));
}

function sessionRejection(event: NormalizedEvent, trackingStartedAt: string): string | null {
  if (event.details.kind !== "session.started" && event.details.kind !== "session.content_added") {
    return null;
  }
  const decision = evaluateSessionEligibility({
    createdAt: event.details.createdAt,
    trackingStartedAt,
    workingFolder: "/already-matched",
    selectedRoots: ["/already-matched"],
  });
  if (!decision.eligible && decision.reason === "created_before_tracking") {
    return "created_before_tracking";
  }
  if (!decision.eligible && decision.reason === "missing_creation_time") {
    return "missing_creation_time";
  }
  return null;
}

function eventIdOf(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "eventId" in value && typeof value.eventId === "string") {
    return value.eventId;
  }
  return null;
}
