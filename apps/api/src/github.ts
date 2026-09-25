import { createHmac, timingSafeEqual } from "node:crypto";
import {
  normalizedEventSchema,
  SCHEMA_VERSION,
  type NormalizedEvent,
} from "@apm/shared";

type JsonRecord = Record<string, unknown>;

const handledEvents = [
  "ping",
  "pull_request",
  "pull_request_review",
  "workflow_run",
  "workflow_job",
  "installation",
  "installation_repositories",
] as const;

type HandledEvent = (typeof handledEvents)[number];

export type WebhookResult =
  | { status: "events"; events: NormalizedEvent[] }
  | { status: "ignore"; note: string };

export function readWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET is missing or empty. Refusing to start because an empty secret would accept forged webhooks.",
    );
  }
  return secret;
}

export function verifyGithubSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (secret.trim() === "") {
    return false;
  }
  if (!header?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const received = header.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandledEvent(name: string): name is HandledEvent {
  return handledEvents.some((eventName) => eventName === name);
}

function repositoryId(payload: JsonRecord): number | null {
  return isRecord(payload.repository) && typeof payload.repository.id === "number"
    ? payload.repository.id
    : null;
}

function iso(value: unknown, fallback: string): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

export function normalizeGithubDelivery(input: {
  eventName: string;
  deliveryId: string;
  projectId: string;
  payload: unknown;
  receivedAt: string;
}): WebhookResult {
  if (!isHandledEvent(input.eventName)) {
    return { status: "ignore", note: "unsupported_event" };
  }
  const payload = input.payload;
  if (!isRecord(payload)) {
    return { status: "ignore", note: "invalid_payload" };
  }
  const delivery = {
    deliveryId: input.deliveryId,
    projectId: input.projectId,
    payload,
    receivedAt: input.receivedAt,
  };

  switch (input.eventName) {
    case "ping":
      return { status: "ignore", note: "ping" };
    case "installation":
    case "installation_repositories":
      return { status: "ignore", note: "access_change" };
    case "pull_request":
      return pullRequestEvent(delivery);
    case "pull_request_review":
      return reviewEvent(delivery);
    case "workflow_run":
      return workflowRunEvent(delivery);
    case "workflow_job":
      return workflowJobEvent(delivery);
    default: {
      const unexpected: never = input.eventName;
      return { status: "ignore", note: `unexpected:${unexpected}` };
    }
  }
}

function pullRequestEvent(input: {
  deliveryId: string;
  projectId: string;
  payload: JsonRecord;
  receivedAt: string;
}): WebhookResult {
  const event = pullRequestFromPayload(input, `github:${input.deliveryId}`);
  return event ? { status: "events", events: [event] } : { status: "ignore", note: "invalid_pull_request" };
}

function pullRequestFromPayload(
  input: { projectId: string; payload: JsonRecord; receivedAt: string },
  eventId: string,
): NormalizedEvent | null {
  const pullRequest = input.payload.pull_request;
  const repoId = repositoryId(input.payload);
  if (!isRecord(pullRequest) || repoId === null || typeof pullRequest.id !== "number") {
    return null;
  }
  const updatedAt = iso(pullRequest.updated_at, input.receivedAt);
  const author = isRecord(pullRequest.user) && typeof pullRequest.user.login === "string" ? pullRequest.user.login : "";
  return normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId,
    sourceKey: `github:pr:${pullRequest.id}:${updatedAt}`,
    projectId: input.projectId,
    source: "github",
    occurredAt: updatedAt,
    details: {
      kind: "pr.updated",
      repositoryId: repoId,
      pullRequestId: pullRequest.id,
      number: typeof pullRequest.number === "number" ? pullRequest.number : 0,
      title: typeof pullRequest.title === "string" ? pullRequest.title : "",
      body: typeof pullRequest.body === "string" ? pullRequest.body : "",
      url: typeof pullRequest.html_url === "string" ? pullRequest.html_url : "https://github.com",
      draft: pullRequest.draft === true,
      state: pullRequest.state === "closed" ? "closed" : "open",
      merged: typeof pullRequest.merged_at === "string",
      headSha: isRecord(pullRequest.head) && typeof pullRequest.head.sha === "string" ? pullRequest.head.sha : "unknown",
      updatedAt,
      ...(author !== "" ? { author } : {}),
    },
  });
}

function reviewEvent(input: {
  deliveryId: string;
  projectId: string;
  payload: JsonRecord;
  receivedAt: string;
}): WebhookResult {
  const review = input.payload.review;
  const pullRequest = input.payload.pull_request;
  const repoId = repositoryId(input.payload);
  if (!isRecord(review) || !isRecord(pullRequest) || repoId === null) {
    return { status: "ignore", note: "invalid_review" };
  }
  if (typeof review.id !== "number" || typeof pullRequest.id !== "number") {
    return { status: "ignore", note: "invalid_review" };
  }
  const submittedAt = iso(review.submitted_at, input.receivedAt);
  const reviewer = isRecord(review.user) && typeof review.user.login === "string" ? review.user.login : "unknown";
  const event = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: `github:${input.deliveryId}`,
    sourceKey: `github:review:${review.id}`,
    projectId: input.projectId,
    source: "github",
    occurredAt: submittedAt,
    details: {
      kind: "pr.reviewed",
      repositoryId: repoId,
      pullRequestId: pullRequest.id,
      reviewId: review.id,
      reviewer,
      decision: typeof review.state === "string" ? review.state : "commented",
      submittedAt,
    },
  });
  // A review is an update to its pull request, so a pull request first seen through a review still enters the map.
  const pullRequestUpdate = pullRequestFromPayload(input, `github:${input.deliveryId}:pull_request`);
  return { status: "events", events: pullRequestUpdate ? [pullRequestUpdate, event] : [event] };
}

function workflowRunEvent(input: {
  deliveryId: string;
  projectId: string;
  payload: JsonRecord;
  receivedAt: string;
}): WebhookResult {
  const run = input.payload.workflow_run;
  const repoId = repositoryId(input.payload);
  if (!isRecord(run) || repoId === null || typeof run.id !== "number") {
    return { status: "ignore", note: "invalid_workflow_run" };
  }
  const occurredAt = iso(run.updated_at, input.receivedAt);
  const pullRequestNumbers = Array.isArray(run.pull_requests)
    ? run.pull_requests.flatMap((item) => (isRecord(item) && typeof item.number === "number" ? [item.number] : []))
    : [];
  const event = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: `github:${input.deliveryId}`,
    sourceKey: `github:run:${run.id}:${run.run_attempt ?? 1}:${run.status ?? "unknown"}`,
    projectId: input.projectId,
    source: "github",
    occurredAt,
    details: {
      kind: "workflow.updated",
      repositoryId: repoId,
      runId: run.id,
      jobId: null,
      attempt: typeof run.run_attempt === "number" ? run.run_attempt : 1,
      status: typeof run.status === "string" ? run.status : "unknown",
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      headSha: typeof run.head_sha === "string" ? run.head_sha : "unknown",
      pullRequestNumbers,
      url: typeof run.html_url === "string" ? run.html_url : "https://github.com",
    },
  });
  return { status: "events", events: [event] };
}

function workflowJobEvent(input: {
  deliveryId: string;
  projectId: string;
  payload: JsonRecord;
  receivedAt: string;
}): WebhookResult {
  const job = input.payload.workflow_job;
  const repoId = repositoryId(input.payload);
  if (!isRecord(job) || repoId === null || typeof job.id !== "number" || typeof job.run_id !== "number") {
    return { status: "ignore", note: "invalid_workflow_job" };
  }
  const occurredAt = iso(job.completed_at ?? job.started_at, input.receivedAt);
  const event = normalizedEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: `github:${input.deliveryId}`,
    sourceKey: `github:job:${job.id}:${job.status ?? "unknown"}`,
    projectId: input.projectId,
    source: "github",
    occurredAt,
    details: {
      kind: "workflow.updated",
      repositoryId: repoId,
      runId: job.run_id,
      jobId: job.id,
      attempt: typeof job.run_attempt === "number" ? job.run_attempt : 1,
      status: typeof job.status === "string" ? job.status : "unknown",
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
      headSha: typeof job.head_sha === "string" ? job.head_sha : "unknown",
      pullRequestNumbers: [],
      url: typeof job.html_url === "string" ? job.html_url : "https://github.com",
    },
  });
  return { status: "events", events: [event] };
}
