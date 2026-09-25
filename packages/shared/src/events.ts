import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const eventSources = ["github", "codex", "cursor", "claude_code"] as const;
export const eventSourceSchema = z.enum(eventSources);
export type EventSource = z.infer<typeof eventSourceSchema>;

const isoTime = z.string().datetime();

export const prCommitSchema = z.object({
  sha: z.string().min(1),
  message: z.string(),
});

export const prFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
});

export const prUpdatedDetailsSchema = z.object({
  kind: z.literal("pr.updated"),
  repositoryId: z.number().int(),
  pullRequestId: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  headSha: z.string().min(1),
  updatedAt: isoTime,
  commits: z.array(prCommitSchema).optional(),
  files: z.array(prFileSchema).optional(),
});

export const prReviewedDetailsSchema = z.object({
  kind: z.literal("pr.reviewed"),
  repositoryId: z.number().int(),
  pullRequestId: z.number().int(),
  reviewId: z.number().int(),
  reviewer: z.string().min(1),
  decision: z.string().min(1),
  submittedAt: isoTime,
});

export const workflowJobSummarySchema = z.object({
  jobId: z.number().int(),
  name: z.string(),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  attempt: z.number().int(),
});

export const workflowUpdatedDetailsSchema = z.object({
  kind: z.literal("workflow.updated"),
  repositoryId: z.number().int(),
  runId: z.number().int(),
  jobId: z.number().int().nullable(),
  attempt: z.number().int(),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  headSha: z.string().min(1),
  pullRequestNumbers: z.array(z.number().int()),
  url: z.string().url(),
  jobs: z.array(workflowJobSummarySchema).optional(),
});

export const sessionStartedDetailsSchema = z.object({
  kind: z.literal("session.started"),
  sessionId: z.string().min(1),
  createdAt: isoTime,
  sourceVersion: z.string().nullable(),
});

export const sessionMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  occurredAt: isoTime,
});

export const sessionContentDetailsSchema = z.object({
  kind: z.literal("session.content_added"),
  sessionId: z.string().min(1),
  createdAt: isoTime,
  sourceVersion: z.string().nullable(),
  recordIds: z.array(z.string().min(1)),
  messages: z.array(sessionMessageSchema),
});

export const eventDetailsSchema = z.discriminatedUnion("kind", [
  prUpdatedDetailsSchema,
  prReviewedDetailsSchema,
  workflowUpdatedDetailsSchema,
  sessionStartedDetailsSchema,
  sessionContentDetailsSchema,
]);

export const normalizedEventSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    eventId: z.string().min(1),
    sourceKey: z.string().min(1),
    projectId: z.string().uuid(),
    source: eventSourceSchema,
    occurredAt: isoTime,
    details: eventDetailsSchema,
  })
  .superRefine((event, context) => {
    const sessionSources: EventSource[] = ["codex", "cursor", "claude_code"];
    const isSession = event.details.kind.startsWith("session.");
    if (isSession && !sessionSources.includes(event.source)) {
      context.addIssue({
        code: "custom",
        message: "Session events must come from Codex, Cursor, or Claude Code",
        path: ["source"],
      });
    }
    if (!isSession && event.source !== "github") {
      context.addIssue({
        code: "custom",
        message: "Pull request and workflow events must come from GitHub",
        path: ["source"],
      });
    }
  });

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type EventDetails = z.infer<typeof eventDetailsSchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;
