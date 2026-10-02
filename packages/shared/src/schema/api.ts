// HTTP shapes shared by the API and the web app. One schema is the source of both sides' types.
import { z } from "zod";

export const workItemStates = ["planned", "in_progress", "in_review", "merged", "closed", "unknown"] as const;
export const workItemStateSchema = z.enum(workItemStates);
export type WorkItemState = z.infer<typeof workItemStateSchema>;

export const basisSchema = z.enum(["observed", "inferred", "human"]);
export type Basis = z.infer<typeof basisSchema>;

export const roleSchema = z.enum(["owner", "member"]);
export type Role = z.infer<typeof roleSchema>;

export const modelProviderIds = ["openai", "anthropic", "gemini"] as const;
export const modelProviderIdSchema = z.enum(modelProviderIds);
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;

export const contributorsSchema = z.object({
  agents: z.array(z.string()),
  people: z.array(z.string()),
});
export type Contributors = z.infer<typeof contributorsSchema>;

const supportedString = z.object({ value: z.string(), basis: basisSchema });
const supportedState = z.object({ value: workItemStateSchema, basis: basisSchema });

export const historyEntrySchema = z.object({
  revision: z.number(),
  change: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  basis: basisSchema,
  evidenceIds: z.array(z.string()),
  actor: z.string().nullable(),
  at: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const graphWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: workItemStateSchema,
  stateBasis: basisSchema,
  blocked: z.boolean(),
  pullRequests: z.array(z.number()),
  lastActivityAt: z.string().nullable(),
});
export type GraphWorkItem = z.infer<typeof graphWorkItemSchema>;

export const graphFeatureSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  counts: z.partialRecord(workItemStateSchema, z.number()),
  contributors: contributorsSchema,
  lastActivityAt: z.string().nullable(),
  workItems: z.array(graphWorkItemSchema),
});
export type GraphFeature = z.infer<typeof graphFeatureSchema>;

export const relationshipSchema = z.object({
  id: z.string(),
  kind: z.literal("depends_on"),
  from: z.string(),
  to: z.string(),
  basis: basisSchema,
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const graphSchema = z.object({
  revision: z.number(),
  features: z.array(graphFeatureSchema),
  relationships: z.array(relationshipSchema),
  pendingAnalysis: z.number(),
  pendingSince: z.string().nullable(),
});
export type Graph = z.infer<typeof graphSchema>;

export const graphRevisionSchema = z.object({
  revision: z.number().nullable(),
  pendingAnalysis: z.number(),
  pendingSince: z.string().nullable(),
});
export type GraphRevision = z.infer<typeof graphRevisionSchema>;

const workflowRunSchema = z.object({
  artifactId: z.string(),
  runId: z.number(),
  url: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  attempt: z.number(),
  attempts: z.array(
    z.object({
      attempt: z.number(),
      status: z.string(),
      conclusion: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
  jobs: z.array(
    z.object({
      jobId: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      attempt: z.number(),
      updatedAt: z.string(),
    }),
  ),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const pullRequestDetailSchema = z.object({
  artifactId: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  author: z.string().nullable(),
  reviews: z.array(
    z.object({
      reviewId: z.number(),
      reviewer: z.string(),
      decision: z.string(),
      submittedAt: z.string(),
    }),
  ),
  basis: basisSchema,
  runs: z.array(workflowRunSchema),
});
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

export const evidenceDetailSchema = z.object({
  id: z.string(),
  kind: z.enum(["session_excerpt", "pull_request"]),
  source: z.string(),
  sessionId: z.string().nullable(),
  excerpt: z.string(),
  observedAt: z.string(),
  basis: basisSchema,
});
export type EvidenceDetail = z.infer<typeof evidenceDetailSchema>;

export const workItemDetailSchema = z.object({
  id: z.string(),
  mergedFrom: z.string().optional(),
  feature: z.object({ id: z.string(), title: z.string() }),
  title: supportedString,
  summary: supportedString,
  state: supportedState,
  blocked: z.object({ reason: z.string().nullable() }).nullable(),
  contributors: contributorsSchema,
  pullRequests: z.array(pullRequestDetailSchema),
  evidence: z.array(evidenceDetailSchema),
  relationships: z.array(
    z.object({
      id: z.string(),
      direction: z.enum(["depends_on", "needed_by"]),
      workItemId: z.string(),
      title: z.string(),
      basis: basisSchema,
      evidenceIds: z.array(z.string()),
    }),
  ),
  history: z.array(historyEntrySchema),
  updatedAt: z.string(),
});
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

export const workItemResponseSchema = z.object({
  revision: z.number(),
  workItem: workItemDetailSchema,
});

export const featureDetailSchema = z.object({
  id: z.string(),
  mergedFrom: z.string().optional(),
  title: supportedString,
  summary: supportedString,
  workItems: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      state: workItemStateSchema,
      stateBasis: basisSchema,
      blocked: z.boolean(),
    }),
  ),
  contributors: contributorsSchema,
  history: z.array(historyEntrySchema),
});
export type FeatureDetail = z.infer<typeof featureDetailSchema>;

export const featureResponseSchema = z.object({
  revision: z.number(),
  feature: featureDetailSchema,
});

export const projectSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  repoId: z.number(),
  trackingStartedAt: z.string(),
  role: roleSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.object({ projects: z.array(projectSchema) });

export const connectedProjectSchema = projectSchema.omit({ role: true });
export const connectProjectResponseSchema = z.object({ project: connectedProjectSchema });

const invitationSchema = z.object({
  id: z.string(),
  project: z.object({ id: z.string(), owner: z.string(), name: z.string() }),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingInvitation = z.infer<typeof invitationSchema>;

export const meSchema = z.object({
  user: z.object({
    id: z.string(),
    githubLogin: z.string().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  invitations: z.array(invitationSchema),
});
export type Me = z.infer<typeof meSchema>;

export const projectSettingsSchema = z.object({
  project: z.object({
    id: z.string(),
    owner: z.string(),
    name: z.string(),
    repoId: z.number(),
    trackingStartedAt: z.string(),
  }),
  role: roleSchema,
  members: z.array(
    z.object({
      userId: z.string(),
      githubLogin: z.string().nullable(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      role: roleSchema,
      joinedAt: z.string(),
      you: z.boolean(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.string(),
      githubLogin: z.string(),
      invitedBy: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  devices: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      pairedBy: z.string().nullable(),
      createdAt: z.string(),
      lastSeenAt: z.string().nullable(),
      yours: z.boolean(),
    }),
  ),
  health: z.object({
    github: z.object({
      lastDeliveryAt: z.string().nullable(),
      failedDeliveries: z.number(),
      waitingDeliveries: z.number(),
    }),
    local: z.object({ lastSessionEventAt: z.string().nullable() }),
    analysis: z.object({
      waiting: z.number(),
      waitingSince: z.string().nullable(),
      gaveUp: z.number(),
      lastAnalyzedAt: z.string().nullable(),
      lastFailure: z.object({ at: z.string(), error: z.string() }).nullable(),
      model: z.object({
        provider: modelProviderIdSchema.nullable(),
        source: z.enum(["owner", "server", "none"]),
      }),
    }),
  }),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const modelCredentialSchema = z.object({
  provider: modelProviderIdSchema,
  model: z.string(),
  hint: z.string(),
  updatedAt: z.string(),
});
export type ModelCredential = z.infer<typeof modelCredentialSchema>;

export const supplierModelSchema = z.object({ id: z.string(), label: z.string() });
export type SupplierModel = z.infer<typeof supplierModelSchema>;

export const modelSetupSchema = z.object({
  credential: modelCredentialSchema.nullable(),
  serverFallback: z.boolean(),
  providers: z.array(
    z.object({
      id: modelProviderIdSchema,
      label: z.string(),
      defaultModel: z.string(),
      keyHint: z.string(),
    }),
  ),
});
export type ModelSetup = z.infer<typeof modelSetupSchema>;

export const supplierModelListSchema = z.object({ models: z.array(supplierModelSchema) });

export const nodePositionSchema = z.object({
  nodeId: z.string(),
  x: z.number(),
  y: z.number(),
});
export type NodePosition = z.infer<typeof nodePositionSchema>;

export const layoutSchema = z.object({ positions: z.array(nodePositionSchema) });
export const savedLayoutSchema = z.object({ saved: z.number() });

const id = z.string().uuid();
const title = z.string().trim().min(1).max(120);

export const correctionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename"), target: z.enum(["feature", "work_item"]), id, title }),
  z.object({ kind: z.literal("move"), workItemId: id, featureId: id }),
  z.object({ kind: z.literal("merge"), target: z.enum(["feature", "work_item"]), retiredId: id, survivingId: id }),
  z.object({
    kind: z.literal("split"),
    workItemId: id,
    title,
    evidenceIds: z.array(id).default([]),
    artifactIds: z.array(id).default([]),
  }),
  z.object({ kind: z.literal("dismiss"), relationshipId: id }),
]);
export type Correction = z.infer<typeof correctionSchema>;

export const correctionResultSchema = z.object({
  status: z.literal("applied"),
  revision: z.number(),
  createdWorkItemId: z.string().nullable(),
});

export const acceptedInvitationSchema = z.object({ projectId: z.string() });
export const createdInvitationSchema = z.object({ id: z.string() });
export const pairingCodeSchema = z.object({ code: z.string(), expiresAt: z.string() });
