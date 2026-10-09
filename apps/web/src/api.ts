import {
  acceptedInvitationSchema,
  connectProjectResponseSchema,
  correctionResultSchema,
  createdInvitationSchema,
  featureResponseSchema,
  graphRevisionSchema,
  graphSchema,
  layoutSchema,
  meSchema,
  modelCredentialSchema,
  modelSetupSchema,
  pairingCodeSchema,
  projectListSchema,
  projectSettingsSchema,
  savedLayoutSchema,
  supplierModelListSchema,
  workItemResponseSchema,
  type Basis,
  type Contributors,
  type Correction,
  type EvidenceDetail,
  type FeatureDetail,
  type Graph,
  type GraphFeature,
  type GraphWorkItem,
  type HistoryEntry,
  type Me,
  type ModelCredential,
  type ModelProviderId,
  type ModelSetup,
  type NodePosition,
  type Project,
  type ProjectSettings,
  type PullRequestDetail,
  type Relationship,
  type Role,
  type SupplierModel,
  type WorkItemDetail,
  type WorkItemState,
  type WorkflowRun,
} from "@apm/shared";

export type {
  Basis,
  Contributors,
  Correction,
  EvidenceDetail,
  FeatureDetail,
  Graph,
  GraphFeature,
  GraphWorkItem,
  HistoryEntry,
  Me,
  ModelCredential,
  ModelProviderId,
  ModelSetup,
  NodePosition,
  Project,
  ProjectSettings,
  PullRequestDetail,
  Relationship,
  Role,
  SupplierModel,
  WorkItemDetail,
  WorkItemState,
  WorkflowRun,
};

export type HelperPausedSession = { provider: string; sessionId: string; reason: string | null };

/** How the helper on this computer is doing for one project. */
export type HelperProjectStatus = {
  projectId: string;
  projectName: string | null;
  trackingStartedAt: string;
  needsPairing: boolean;
  selectedFolders: number;
  lastUploadAt: string | null;
  queued: number;
  paused: HelperPausedSession[];
  lastError: string | null;
  nextUploadAt: string | null;
};

export type HelperStatus = {
  paired: boolean;
  needsPairing: boolean;
  selectedFolders: number;
  lastScanAt: string | null;
  lastUploadAt: string | null;
  queued: number;
  uploaded: number;
  dropped: number;
  paused: HelperPausedSession[];
  lastError: string | null;
  nextUploadAt: string | null;
  projects: HelperProjectStatus[];
};

export const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
export const helperUrl = import.meta.env.VITE_HELPER_URL || "http://127.0.0.1:47321";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Parser<T> = { parse(data: unknown): T };

async function request<T>(path: string, token: string, schema: Parser<T>, init?: RequestInit): Promise<T> {
  const response = await send(path, token, init);
  try {
    return schema.parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API response did not match the expected shape.";
    throw new ApiError(message, response.status);
  }
}

async function requestEmpty(path: string, token: string, init?: RequestInit): Promise<void> {
  await send(path, token, init);
}

async function send(path: string, token: string, init?: RequestInit): Promise<Response> {
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
  return response;
}

export const api = {
  me: (token: string) => request("/me", token, meSchema),
  projects: (token: string) => request("/projects", token, projectListSchema),
  connectProject: (token: string, input: { owner: string; name: string }) =>
    request("/projects", token, connectProjectResponseSchema, { method: "POST", body: JSON.stringify(input) }),
  acceptInvitation: (token: string, invitationId: string) =>
    request(`/invitations/${invitationId}/accept`, token, acceptedInvitationSchema, { method: "POST" }),

  graph: (token: string, projectId: string) => request(`/projects/${projectId}/graph`, token, graphSchema),
  revision: (token: string, projectId: string) => request(`/projects/${projectId}/graph/revision`, token, graphRevisionSchema),
  workItem: (token: string, projectId: string, id: string) =>
    request(`/projects/${projectId}/work-items/${id}`, token, workItemResponseSchema),
  feature: (token: string, projectId: string, id: string) =>
    request(`/projects/${projectId}/features/${id}`, token, featureResponseSchema),
  correct: (token: string, projectId: string, correction: Correction) =>
    request(`/projects/${projectId}/corrections`, token, correctionResultSchema, {
      method: "POST",
      body: JSON.stringify(correction),
    }),

  layout: (token: string, projectId: string) => request(`/projects/${projectId}/layout`, token, layoutSchema),
  saveLayout: (token: string, projectId: string, positions: NodePosition[]) =>
    request(`/projects/${projectId}/layout`, token, savedLayoutSchema, { method: "PUT", body: JSON.stringify({ positions }) }),

  settings: (token: string, projectId: string) => request(`/projects/${projectId}/settings`, token, projectSettingsSchema),
  modelSetup: (token: string) => request("/me/model", token, modelSetupSchema),
  supplierModels: (token: string, input: { provider: ModelProviderId; apiKey: string }) =>
    request("/me/model/models", token, supplierModelListSchema, { method: "POST", body: JSON.stringify(input) }),
  saveModelCredential: (token: string, input: { provider: ModelProviderId; apiKey: string; model: string }) =>
    request("/me/model", token, modelCredentialSchema, { method: "PUT", body: JSON.stringify(input) }),
  deleteModelCredential: (token: string) => requestEmpty("/me/model", token, { method: "DELETE" }),
  invite: (token: string, projectId: string, githubLogin: string) =>
    request(`/projects/${projectId}/invitations`, token, createdInvitationSchema, {
      method: "POST",
      body: JSON.stringify({ githubLogin }),
    }),
  revokeInvitation: (token: string, projectId: string, invitationId: string) =>
    requestEmpty(`/projects/${projectId}/invitations/${invitationId}`, token, { method: "DELETE" }),
  removeMember: (token: string, projectId: string, userId: string) =>
    requestEmpty(`/projects/${projectId}/members/${userId}`, token, { method: "DELETE" }),
  revokeDevice: (token: string, projectId: string, deviceId: string) =>
    requestEmpty(`/projects/${projectId}/devices/${deviceId}`, token, { method: "DELETE" }),
  deleteProject: (token: string, projectId: string) => requestEmpty(`/projects/${projectId}`, token, { method: "DELETE" }),
  pairingCode: (token: string, projectId: string) =>
    request(`/projects/${projectId}/helper/pairing-codes`, token, pairingCodeSchema, { method: "POST" }),
};

export type HelperFolder = { id: string; projectId: string; canonicalPath: string; enabled: boolean };
export type HelperLogRoot = { id: string; path: string };
export type HelperPairing = { projectId: string; projectName: string | null; trackingStartedAt: string; apiUrl: string };
export type HelperOverview = {
  pairings: HelperPairing[];
  folders: HelperFolder[];
  logRoots: HelperLogRoot[];
  status: HelperStatus | null;
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

export async function addHelperFolder(projectId: string, path: string): Promise<void> {
  await helperRequest("/folders", { method: "POST", body: JSON.stringify({ projectId, path }) }, "Could not add that folder.");
}

/** Stops this computer collecting for one project. Other projects keep collecting. */
export async function removeHelperPairing(projectId: string): Promise<void> {
  await helperRequest(`/pairings/${encodeURIComponent(projectId)}/remove`, { method: "POST", body: "{}" }, "Could not disconnect that project.");
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
