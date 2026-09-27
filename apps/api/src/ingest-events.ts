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
    // Postgres cannot store NUL in jsonb text, and one such event would fail the whole batch.
    if (!parsed.success || containsNul(parsed.data)) {
      rejected.push({ eventId: eventIdOf(candidate) ?? `index:${index}`, reason: "invalid_event" });
      continue;
    }
    if (parsed.data.projectId !== input.projectId) {
      rejected.push({ eventId: parsed.data.eventId, reason: "project_mismatch" });
      continue;
    }
    // Pull request and CI facts decide delivery state, so they only enter through the verified webhook and refresh.
    if (parsed.data.source === "github") {
      rejected.push({ eventId: parsed.data.eventId, reason: "github_events_come_from_github" });
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
    const stored = await insertAndList(client, input.projectId, accepted);
    await client.query("commit");
    return { acknowledged: stored.acknowledged, rejected: [...rejected, ...stored.rejected] };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Event ids are global, so an id already stored for another project is refused rather than acknowledged. */
async function insertAndList(
  client: PoolClient,
  projectId: string,
  events: NormalizedEvent[],
): Promise<{ acknowledged: string[]; rejected: IngestRejection[] }> {
  if (events.length === 0) {
    return { acknowledged: [], rejected: [] };
  }
  await insertEventsWith(client, events);
  const ids = events.map((event) => event.eventId);
  const existing = await client.query<{ event_id: string; project_id: string }>(
    `select event_id, project_id from normalized_events where event_id = any($1::text[])`,
    [ids],
  );
  const owner = new Map(existing.rows.map((row) => [row.event_id, row.project_id]));
  const acknowledged: string[] = [];
  const rejected: IngestRejection[] = [];
  for (const id of ids) {
    const storedFor = owner.get(id);
    if (storedFor === projectId) {
      acknowledged.push(id);
    } else if (storedFor !== undefined) {
      rejected.push({ eventId: id, reason: "event_id_in_other_project" });
    }
  }
  return { acknowledged, rejected };
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

function containsNul(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("\u0000");
  }
  if (Array.isArray(value)) {
    return value.some(containsNul);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsNul);
  }
  return false;
}

function eventIdOf(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "eventId" in value && typeof value.eventId === "string") {
    return value.eventId;
  }
  return null;
}
