export type WorkItemState = "planned" | "in_progress" | "in_review" | "merged" | "closed" | "unknown";
export type Basis = "observed" | "inferred" | "human";
export type Role = "owner" | "member";

export type Project = {
  id: string;
  owner: string;
  name: string;
  repoId: number;
  trackingStartedAt: string;
  role: Role;
};

export type Contributors = { agents: string[]; people: string[] };

export type GraphWorkItem = {
  id: string;
  title: string;
  state: WorkItemState;
  stateBasis: Basis;
  blocked: boolean;
  pullRequests: number[];
  lastActivityAt: string | null;
};

export type GraphFeature = {
  id: string;
  title: string;
  summary: string;
  counts: Partial<Record<WorkItemState, number>>;
  contributors: Contributors;
  lastActivityAt: string | null;
  workItems: GraphWorkItem[];
};

export type Relationship = { id: string; kind: "depends_on"; from: string; to: string; basis: Basis };

export type Graph = {
  revision: number;
  features: GraphFeature[];
  relationships: Relationship[];
  pendingAnalysis: number;
  pendingSince: string | null;
};

export type HistoryEntry = {
  revision: number;
  change: string;
  before: unknown;
  after: unknown;
  basis: Basis;
  evidenceIds: string[];
  actor: string | null;
  at: string;
};

export type WorkflowRun = {
  artifactId: string;
  runId: number;
  url: string;
  status: string;
  conclusion: string | null;
  attempt: number;
  attempts: Array<{ attempt: number; status: string; conclusion: string | null; updatedAt: string }>;
  jobs: Array<{ jobId: number; name: string; status: string; conclusion: string | null; attempt: number; updatedAt: string }>;
};

export type PullRequestDetail = {
  artifactId: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  author: string | null;
  reviews: Array<{ reviewId: number; reviewer: string; decision: string; submittedAt: string }>;
  basis: Basis;
  runs: WorkflowRun[];
};

export type EvidenceDetail = {
  id: string;
  kind: "session_excerpt" | "pull_request";
  source: string;
  sessionId: string | null;
  excerpt: string;
  observedAt: string;
  basis: Basis;
};

export type Supported<T> = { value: T; basis: Basis };

export type WorkItemDetail = {
  id: string;
  mergedFrom?: string;
  feature: { id: string; title: string };
  title: Supported<string>;
  summary: Supported<string>;
  state: Supported<WorkItemState>;
  blocked: { reason: string | null } | null;
  contributors: Contributors;
  pullRequests: PullRequestDetail[];
  evidence: EvidenceDetail[];
  relationships: Array<{
    id: string;
    direction: "depends_on" | "needed_by";
    workItemId: string;
    title: string;
    basis: Basis;
    evidenceIds: string[];
  }>;
  history: HistoryEntry[];
  updatedAt: string;
};

export type FeatureDetail = {
  id: string;
  mergedFrom?: string;
  title: Supported<string>;
  summary: Supported<string>;
  workItems: Array<{ id: string; title: string; summary: string; state: WorkItemState; stateBasis: Basis; blocked: boolean }>;
  contributors: Contributors;
  history: HistoryEntry[];
};

export type Me = {
  user: { id: string; githubLogin: string | null; name: string | null; avatarUrl: string | null };
  invitations: Array<{ id: string; project: { id: string; owner: string; name: string }; invitedBy: string | null; createdAt: string }>;
};

export type ProjectSettings = {
  project: { id: string; owner: string; name: string; repoId: number; trackingStartedAt: string };
  role: Role;
  members: Array<{
    userId: string;
    githubLogin: string | null;
    name: string | null;
    avatarUrl: string | null;
    role: Role;
    joinedAt: string;
    you: boolean;
  }>;
  invitations: Array<{ id: string; githubLogin: string; invitedBy: string | null; createdAt: string }>;
  devices: Array<{ id: string; label: string; pairedBy: string | null; createdAt: string; lastSeenAt: string | null; yours: boolean }>;
  health: {
    github: { lastDeliveryAt: string | null; failedDeliveries: number; waitingDeliveries: number };
    local: { lastSessionEventAt: string | null };
    analysis: {
      waiting: number;
      waitingSince: string | null;
      gaveUp: number;
      lastAnalyzedAt: string | null;
      lastFailure: { at: string; error: string } | null;
      model: { provider: "openai" | "anthropic" | "gemini" | null; source: "owner" | "server" | "none" };
    };
  };
};

export type ModelProviderId = "openai" | "anthropic" | "gemini";

export type ModelCredential = {
  provider: ModelProviderId;
  model: string;
  hint: string;
  updatedAt: string;
};

export type ModelSetup = {
  credential: ModelCredential | null;
  serverFallback: boolean;
  providers: Array<{ id: ModelProviderId; label: string; defaultModel: string; keyHint: string }>;
};

export type SupplierModel = { id: string; label: string };

export type Correction =
  | { kind: "rename"; target: "feature" | "work_item"; id: string; title: string }
  | { kind: "move"; workItemId: string; featureId: string }
  | { kind: "merge"; target: "feature" | "work_item"; retiredId: string; survivingId: string }
  | { kind: "split"; workItemId: string; title: string; evidenceIds: string[]; artifactIds: string[] }
  | { kind: "dismiss"; relationshipId: string };

export type NodePosition = { nodeId: string; x: number; y: number };

export type HelperStatus = {
  paired: boolean;
  needsPairing: boolean;
  selectedFolders: number;
  lastScanAt: string | null;
  lastUploadAt: string | null;
  queued: number;
  lastError: string | null;
};

const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
export const helperUrl = import.meta.env.VITE_HELPER_URL || "http://127.0.0.1:47321";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  me: (token: string) => request<Me>("/me", token),
  projects: (token: string) => request<{ projects: Project[] }>("/projects", token),
  connectProject: (token: string, input: { owner: string; name: string }) =>
    request<{ project: Omit<Project, "role"> }>("/projects", token, { method: "POST", body: JSON.stringify(input) }),
  acceptInvitation: (token: string, invitationId: string) =>
    request<{ projectId: string }>(`/invitations/${invitationId}/accept`, token, { method: "POST" }),

  graph: (token: string, projectId: string) => request<Graph>(`/projects/${projectId}/graph`, token),
  revision: (token: string, projectId: string) =>
    request<{ revision: number | null; pendingAnalysis: number; pendingSince: string | null }>(`/projects/${projectId}/graph/revision`, token),
  workItem: (token: string, projectId: string, id: string) =>
    request<{ revision: number; workItem: WorkItemDetail }>(`/projects/${projectId}/work-items/${id}`, token),
  feature: (token: string, projectId: string, id: string) =>
    request<{ revision: number; feature: FeatureDetail }>(`/projects/${projectId}/features/${id}`, token),
  correct: (token: string, projectId: string, correction: Correction) =>
    request<{ status: "applied"; revision: number; createdWorkItemId: string | null }>(`/projects/${projectId}/corrections`, token, {
      method: "POST",
      body: JSON.stringify(correction),
    }),

  layout: (token: string, projectId: string) => request<{ positions: NodePosition[] }>(`/projects/${projectId}/layout`, token),
  saveLayout: (token: string, projectId: string, positions: NodePosition[]) =>
    request<{ saved: number }>(`/projects/${projectId}/layout`, token, { method: "PUT", body: JSON.stringify({ positions }) }),

  settings: (token: string, projectId: string) => request<ProjectSettings>(`/projects/${projectId}/settings`, token),
  modelSetup: (token: string) => request<ModelSetup>("/me/model", token),
  supplierModels: (token: string, input: { provider: ModelProviderId; apiKey: string }) =>
    request<{ models: SupplierModel[] }>("/me/model/models", token, { method: "POST", body: JSON.stringify(input) }),
  saveModelCredential: (token: string, input: { provider: ModelProviderId; apiKey: string; model: string }) =>
    request<ModelCredential>("/me/model", token, { method: "PUT", body: JSON.stringify(input) }),
  deleteModelCredential: (token: string) => request<void>("/me/model", token, { method: "DELETE" }),
  invite: (token: string, projectId: string, githubLogin: string) =>
    request<{ id: string }>(`/projects/${projectId}/invitations`, token, { method: "POST", body: JSON.stringify({ githubLogin }) }),
  revokeInvitation: (token: string, projectId: string, invitationId: string) =>
    request<void>(`/projects/${projectId}/invitations/${invitationId}`, token, { method: "DELETE" }),
  removeMember: (token: string, projectId: string, userId: string) =>
    request<void>(`/projects/${projectId}/members/${userId}`, token, { method: "DELETE" }),
  revokeDevice: (token: string, projectId: string, deviceId: string) =>
    request<void>(`/projects/${projectId}/devices/${deviceId}`, token, { method: "DELETE" }),
  deleteProject: (token: string, projectId: string) => request<void>(`/projects/${projectId}`, token, { method: "DELETE" }),
  pairingCode: (token: string, projectId: string) =>
    request<{ code: string; expiresAt: string }>(`/projects/${projectId}/helper/pairing-codes`, token, { method: "POST" }),
};

export type HelperFolder = { id: string; canonicalPath: string; enabled: boolean };
export type HelperLogRoot = { id: string; path: string };
export type HelperOverview = {
  pairing: { projectId: string; trackingStartedAt: string; apiUrl: string } | null;
  folders: HelperFolder[];
  logRoots: HelperLogRoot[];
  status: (HelperStatus & {
    uploaded: number;
    dropped: number;
    paused: Array<{ provider: string; sessionId: string; reason: string | null }>;
    nextUploadAt: string | null;
  }) | null;
};

async function helperRequest(path: string, init: RequestInit | undefined, fallback: string): Promise<Response> {
  const response = await fetch(`${helperUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok && response.status !== 204) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : fallback;
    throw new Error(message);
  }
  return response;
}

/** Hands a fresh pairing code to the helper running on this computer. */
export async function pairLocalHelper(code: string, api = apiUrl): Promise<void> {
  await helperRequest("/pair", { method: "POST", body: JSON.stringify({ code, apiUrl: api }) }, "The local helper refused the pairing.");
}

/** Everything the helper page shows, or null when the helper is not running. */
export async function readHelperOverview(): Promise<HelperOverview | null> {
  try {
    const response = await fetch(`${helperUrl}/`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as HelperOverview;
  } catch {
    return null;
  }
}

export async function addHelperFolder(path: string): Promise<void> {
  await helperRequest("/folders", { method: "POST", body: JSON.stringify({ path }) }, "Could not add that folder.");
}

export async function removeHelperFolder(id: string): Promise<void> {
  await helperRequest(`/folders/${encodeURIComponent(id)}/disable`, { method: "POST", body: "{}" }, "Could not remove that folder.");
}

export async function scanHelper(): Promise<void> {
  await helperRequest("/scan", { method: "POST", body: "{}" }, "Scan failed.");
}

/** Status of the helper on this computer, or null when it is not running. */
export async function readHelperStatus(): Promise<HelperStatus | null> {
  try {
    const response = await fetch(`${helperUrl}/status`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { status: HelperStatus | null };
    return body.status;
  } catch {
    return null;
  }
}

export function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
