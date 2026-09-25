export type Project = {
  id: string;
  owner: string;
  name: string;
  repoId: number;
  trackingStartedAt: string;
};

export type StoredEvent = {
  eventId: string;
  source: string;
  occurredAt: string;
  details: { kind: string };
};

const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";

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
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function fetchProjects(token: string): Promise<{ projects: Project[] }> {
  return request("/projects", token);
}

export function connectProject(
  token: string,
  input: { owner: string; name: string; repoId: number },
): Promise<{ project: Project }> {
  return request("/projects", token, { method: "POST", body: JSON.stringify(input) });
}

export function fetchEvents(token: string, projectId: string): Promise<{ events: StoredEvent[] }> {
  return request(`/projects/${projectId}/events`, token);
}

export function createPairingCode(
  token: string,
  projectId: string,
): Promise<{ code: string; expiresAt: string }> {
  return request(`/projects/${projectId}/collector/pairing-codes`, token, { method: "POST" });
}
