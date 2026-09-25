import {
  serializeIngestedSession,
  sha256Hex,
  splitSessionBytes,
  type IngestedSession,
  type SessionAgent,
} from "@apm/shared";

export type SessionUploadAck = {
  acknowledged: number[];
  chunkCount: number | null;
  contentSha256: string | null;
  complete: boolean;
  stored: boolean | null;
  reason: string | null;
  eventsStored: number | null;
};

export type SessionChunkRequest = {
  projectId: string;
  source: SessionAgent;
  sessionId: string;
  chunkIndex: number;
  chunkCount: number;
  contentSha256: string;
  payloadBase64: string;
  replace: boolean;
};

export type SessionUploadTransport = {
  status(input: {
    projectId: string;
    source: SessionAgent;
    sessionId: string;
    contentSha256: string;
  }): Promise<SessionUploadAck>;
  reset(input: { projectId: string; source: SessionAgent; sessionId: string }): Promise<void>;
  send(chunk: SessionChunkRequest): Promise<SessionUploadAck>;
};

const emptyAck: SessionUploadAck = {
  acknowledged: [],
  chunkCount: null,
  contentSha256: null,
  complete: false,
  stored: null,
  reason: null,
  eventsStored: null,
};

export async function uploadSessionChunks(input: {
  projectId: string;
  session: IngestedSession;
  transport: SessionUploadTransport;
  chunkBytes?: number;
}): Promise<SessionUploadAck> {
  const serialized = serializeIngestedSession(input.session);
  const pieces = splitSessionBytes(serialized, input.chunkBytes);
  const contentSha256 = sha256Hex(Buffer.concat(pieces));
  let status = await input.transport.status({
    projectId: input.projectId,
    source: input.session.source,
    sessionId: input.session.sessionId,
    contentSha256,
  });

  if (status.complete && status.contentSha256 === contentSha256) {
    return status;
  }

  if (status.contentSha256 !== null && status.contentSha256 !== contentSha256 && status.acknowledged.length > 0) {
    await input.transport.reset({
      projectId: input.projectId,
      source: input.session.source,
      sessionId: input.session.sessionId,
    });
    status = emptyAck;
  }

  const acknowledged =
    status.contentSha256 === contentSha256 ? new Set(status.acknowledged) : new Set<number>();
  const pending: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    if (!acknowledged.has(index)) {
      pending.push(index);
    }
  }
  if (pending.length === 0 && pieces.length > 0) {
    pending.push(pieces.length - 1);
  }

  let last: SessionUploadAck = status;
  for (const index of pending) {
    const piece = pieces[index];
    if (!piece) {
      throw new Error(`Missing session chunk ${index}.`);
    }
    last = await input.transport.send({
      projectId: input.projectId,
      source: input.session.source,
      sessionId: input.session.sessionId,
      chunkIndex: index,
      chunkCount: pieces.length,
      contentSha256,
      payloadBase64: piece.toString("base64"),
      replace: false,
    });
  }
  if (!last.complete) {
    throw new Error("Session upload finished without a complete acknowledgement.");
  }
  return last;
}

export function createFetchSessionUploadTransport(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): SessionUploadTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  return {
    async status(query) {
      const params = new URLSearchParams({
        projectId: query.projectId,
        source: query.source,
        sessionId: query.sessionId,
        contentSha256: query.contentSha256,
      });
      return readAck(await authorized(fetchImpl, `${baseUrl}/ingest/sessions/chunks?${params}`, input.token));
    },
    async reset(query) {
      const params = new URLSearchParams({
        projectId: query.projectId,
        source: query.source,
        sessionId: query.sessionId,
      });
      const response = await authorized(fetchImpl, `${baseUrl}/ingest/sessions/chunks?${params}`, input.token, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
    },
    async send(chunk) {
      const response = await authorized(fetchImpl, `${baseUrl}/ingest/sessions/chunks`, input.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: chunk.projectId,
          source: chunk.source,
          sessionId: chunk.sessionId,
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunk.chunkCount,
          contentSha256: chunk.contentSha256,
          payload: chunk.payloadBase64,
          ...(chunk.replace ? { replace: true } : {}),
        }),
      });
      return readAck(response);
    },
  };
}

async function authorized(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetchImpl(url, {
    ...init,
    headers,
  });
}

async function readAck(response: Response): Promise<SessionUploadAck> {
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Session upload response was empty.");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.acknowledged) || typeof record.complete !== "boolean") {
    throw new Error("Session upload response was invalid.");
  }
  return {
    acknowledged: record.acknowledged.filter((value): value is number => typeof value === "number"),
    chunkCount: typeof record.chunkCount === "number" ? record.chunkCount : null,
    contentSha256: typeof record.contentSha256 === "string" ? record.contentSha256 : null,
    complete: record.complete,
    stored: typeof record.stored === "boolean" ? record.stored : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    eventsStored: typeof record.eventsStored === "number" ? record.eventsStored : null,
  };
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `Session upload failed (${response.status}).`;
}
