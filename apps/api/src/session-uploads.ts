import type { Pool, PoolClient } from "pg";
import {
  buildSessionEvents,
  evaluateSessionEligibility,
  ingestedSessionSchema,
  joinSessionBytes,
  sha256Hex,
  type SessionAgent,
} from "@apm/shared";
import { insertEventsWith } from "./store.js";

export type SessionOutcome = {
  stored: boolean;
  reason: string | null;
  eventsStored: number;
};

export type SessionUploadView = {
  acknowledged: number[];
  chunkCount: number | null;
  contentSha256: string | null;
  complete: boolean;
  outcome: SessionOutcome | null;
};

export type AcceptChunkInput = {
  projectId: string;
  source: SessionAgent;
  sessionId: string;
  chunkIndex: number;
  chunkCount: number;
  contentSha256: string;
  payload: Buffer;
  replace: boolean;
};

export type AcceptChunkResult =
  | { status: "ack"; upload: SessionUploadView }
  | { status: "conflict" }
  | { status: "invalid"; message: string };

type ChunkRow = {
  chunk_index: number;
  chunk_count: number;
  content_sha256: string;
  payload: unknown;
};

type ReceiptRow = {
  chunk_count: number;
  content_sha256: string;
  stored: boolean;
  reason: string | null;
  events_stored: number;
};

const emptyUpload: SessionUploadView = {
  acknowledged: [],
  chunkCount: null,
  contentSha256: null,
  complete: false,
  outcome: null,
};

export async function getSessionUpload(
  pool: Pool,
  input: { projectId: string; source: SessionAgent; sessionId: string; contentSha256: string | null },
): Promise<SessionUploadView> {
  if (input.contentSha256) {
    const receipt = await pool.query<ReceiptRow>(
      `select chunk_count, content_sha256, stored, reason, events_stored
       from session_upload_receipts
       where project_id = $1 and source = $2 and session_id = $3 and content_sha256 = $4`,
      [input.projectId, input.source, input.sessionId, input.contentSha256],
    );
    const row = receipt.rows[0];
    if (row) {
      return viewFromReceipt(row);
    }
  }

  const chunks = await pool.query<ChunkRow>(
    `select chunk_index, chunk_count, content_sha256, payload
     from session_upload_chunks
     where project_id = $1 and source = $2 and session_id = $3
     order by chunk_index`,
    [input.projectId, input.source, input.sessionId],
  );
  return viewFromChunks(chunks.rows);
}

export async function resetSessionUpload(
  pool: Pool,
  input: { projectId: string; source: SessionAgent; sessionId: string },
): Promise<void> {
  await pool.query(
    `delete from session_upload_chunks
     where project_id = $1 and source = $2 and session_id = $3`,
    [input.projectId, input.source, input.sessionId],
  );
}

export async function acceptSessionChunk(pool: Pool, input: AcceptChunkInput): Promise<AcceptChunkResult> {
  if (input.chunkIndex >= input.chunkCount) {
    return { status: "invalid", message: "Chunk index is outside this upload." };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      input.projectId,
      `${input.source}:${input.sessionId}`,
    ]);

    const existingReceipt = await client.query<ReceiptRow>(
      `select chunk_count, content_sha256, stored, reason, events_stored
       from session_upload_receipts
       where project_id = $1 and source = $2 and session_id = $3 and content_sha256 = $4`,
      [input.projectId, input.source, input.sessionId, input.contentSha256],
    );
    const receipt = existingReceipt.rows[0];
    if (receipt) {
      await client.query("commit");
      return { status: "ack", upload: viewFromReceipt(receipt) };
    }

    let rows = await loadChunks(client, input.projectId, input.source, input.sessionId);
    if (rows.length > 0 && !sameManifest(rows, input)) {
      if (!input.replace) {
        await client.query("rollback");
        return { status: "conflict" };
      }
      await deleteChunks(client, input.projectId, input.source, input.sessionId);
      rows = [];
    }

    const current = rows.find((row) => row.chunk_index === input.chunkIndex);
    if (current) {
      if (!current.payload.equals(input.payload)) {
        await client.query("rollback");
        return { status: "conflict" };
      }
    } else {
      await client.query(
        `insert into session_upload_chunks
          (project_id, source, session_id, chunk_index, chunk_count, content_sha256, payload)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.projectId,
          input.source,
          input.sessionId,
          input.chunkIndex,
          input.chunkCount,
          input.contentSha256,
          input.payload,
        ],
      );
      rows.push({
        chunk_index: input.chunkIndex,
        chunk_count: input.chunkCount,
        content_sha256: input.contentSha256,
        payload: input.payload,
      });
    }

    if (rows.length < input.chunkCount) {
      await client.query("commit");
      return {
        status: "ack",
        upload: {
          acknowledged: rows.map((row) => row.chunk_index).sort((left, right) => left - right),
          chunkCount: input.chunkCount,
          contentSha256: input.contentSha256,
          complete: false,
          outcome: null,
        },
      };
    }

    const ordered = rows.slice().sort((left, right) => left.chunk_index - right.chunk_index);
    const completeSet = ordered.every((row, index) => row.chunk_index === index);
    if (!completeSet) {
      await client.query("commit");
      return {
        status: "ack",
        upload: {
          acknowledged: ordered.map((row) => row.chunk_index),
          chunkCount: input.chunkCount,
          contentSha256: input.contentSha256,
          complete: false,
          outcome: null,
        },
      };
    }

    const joined = Buffer.concat(ordered.map((row) => row.payload));
    if (sha256Hex(joined) !== input.contentSha256) {
      await client.query("rollback");
      return {
        status: "invalid",
        message: "Reassembled session does not match the declared content hash. Reset the upload and send it again.",
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(joinSessionBytes(ordered.map((row) => row.payload))) as unknown;
    } catch {
      await client.query("rollback");
      return { status: "invalid", message: "Reassembled session is not JSON." };
    }
    const parsed = ingestedSessionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      await client.query("rollback");
      return { status: "invalid", message: "Reassembled session is invalid." };
    }
    if (parsed.data.source !== input.source || parsed.data.sessionId !== input.sessionId) {
      await client.query("rollback");
      return { status: "invalid", message: "Reassembled session identity does not match the upload." };
    }

    const project = await client.query<{ tracking_started_at: Date }>(
      `select tracking_started_at from projects where id = $1`,
      [input.projectId],
    );
    const trackingStartedAt = project.rows[0]?.tracking_started_at;
    if (!trackingStartedAt) {
      await client.query("rollback");
      return { status: "invalid", message: "Project not found." };
    }

    const decision = evaluateSessionEligibility({
      createdAt: parsed.data.createdAt,
      trackingStartedAt: trackingStartedAt.toISOString(),
      workingFolder: parsed.data.workingFolder,
      selectedRoots: parsed.data.selectedRoots,
    });
    const outcome: SessionOutcome = decision.eligible
      ? {
          stored: true,
          reason: null,
          eventsStored: await insertEventsWith(client, buildSessionEvents({ projectId: input.projectId, session: parsed.data })),
        }
      : { stored: false, reason: decision.reason, eventsStored: 0 };

    await client.query(
      `insert into session_upload_receipts
        (project_id, source, session_id, content_sha256, chunk_count, stored, reason, events_stored)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (project_id, source, session_id, content_sha256) do nothing`,
      [
        input.projectId,
        input.source,
        input.sessionId,
        input.contentSha256,
        input.chunkCount,
        outcome.stored,
        outcome.reason,
        outcome.eventsStored,
      ],
    );
    await deleteChunks(client, input.projectId, input.source, input.sessionId);
    await client.query("commit");
    return {
      status: "ack",
      upload: {
        acknowledged: acknowledgedRange(input.chunkCount),
        chunkCount: input.chunkCount,
        contentSha256: input.contentSha256,
        complete: true,
        outcome,
      },
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function sameManifest(rows: Array<{ content_sha256: string; chunk_count: number }>, input: AcceptChunkInput): boolean {
  return rows.every((row) => row.content_sha256 === input.contentSha256 && row.chunk_count === input.chunkCount);
}

async function loadChunks(client: PoolClient, projectId: string, source: string, sessionId: string): Promise<Array<ChunkRow & { payload: Buffer }>> {
  const result = await client.query<ChunkRow>(
    `select chunk_index, chunk_count, content_sha256, payload
     from session_upload_chunks
     where project_id = $1 and source = $2 and session_id = $3
     order by chunk_index
     for update`,
    [projectId, source, sessionId],
  );
  return result.rows.map((row) => ({ ...row, payload: asPayload(row.payload) }));
}

async function deleteChunks(client: PoolClient, projectId: string, source: string, sessionId: string): Promise<void> {
  await client.query(
    `delete from session_upload_chunks
     where project_id = $1 and source = $2 and session_id = $3`,
    [projectId, source, sessionId],
  );
}

function viewFromChunks(rows: ChunkRow[]): SessionUploadView {
  const first = rows[0];
  if (!first) {
    return emptyUpload;
  }
  return {
    acknowledged: rows.map((row) => row.chunk_index),
    chunkCount: first.chunk_count,
    contentSha256: first.content_sha256,
    complete: false,
    outcome: null,
  };
}

function viewFromReceipt(row: ReceiptRow): SessionUploadView {
  return {
    acknowledged: acknowledgedRange(row.chunk_count),
    chunkCount: row.chunk_count,
    contentSha256: row.content_sha256,
    complete: true,
    outcome: {
      stored: row.stored,
      reason: row.reason,
      eventsStored: row.events_stored,
    },
  };
}

function acknowledgedRange(count: number): number[] {
  return Array.from({ length: count }, (_value, index) => index);
}

function asPayload(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  throw new Error("Session chunk payload was not stored as bytes.");
}
