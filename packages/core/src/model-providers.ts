import { modelProviderIdSchema, type ModelProviderId } from "@apm/shared";
import { defaultOpenAiModel } from "./graph/openai-interpreter.js";

export const modelProviders = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: defaultOpenAiModel,
    keyHint: "A key from platform.openai.com.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-haiku-4-5",
    keyHint: "A key from console.anthropic.com.",
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultModel: "gemini-2.5-flash",
    keyHint: "A key from aistudio.google.com.",
  },
] as const;

export type { ModelProviderId };

export type ModelProviderSpec = (typeof modelProviders)[number];

export function isModelProviderId(value: string): value is ModelProviderId {
  return modelProviderIdSchema.safeParse(value).success;
}

export function modelProvider(id: ModelProviderId): ModelProviderSpec {
  const spec = modelProviders.find((provider) => provider.id === id);
  if (!spec) {
    throw new Error(`Unknown model supplier ${id}.`);
  }
  return spec;
}

export const modelIdPattern = /^[A-Za-z0-9_.:/@+-]{1,120}$/;

export type ModelKeyCheckResult = { ok: true } | { ok: false; error: string };

export type ModelKeyCheck = (input: { provider: ModelProviderId; apiKey: string; model: string }) => Promise<ModelKeyCheckResult>;

export type SupplierModel = { id: string; label: string };

export type SupplierModelList = { ok: true; models: SupplierModel[] } | { ok: false; error: string };

export type ListSupplierModels = (input: { provider: ModelProviderId; apiKey: string }) => Promise<SupplierModelList>;

/** Confirms the key is accepted by the supplier. Does not spend a completion. */
export async function checkModelKey(
  input: { provider: ModelProviderId; apiKey: string; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ModelKeyCheckResult> {
  const request = keyCheckRequest(input.provider, input.apiKey);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: `Could not reach ${modelProvider(input.provider).label} to check the key.` };
  }
  if (response.ok) {
    return { ok: true };
  }
  const body = clip(await response.text(), input.apiKey);
  const detail = errorDetail(body);
  const label = modelProvider(input.provider).label;
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && /api[_ ]?key|invalid|unauthor/i.test(detail))
  ) {
    return { ok: false, error: `${label} rejected that key. Check that it belongs to this supplier and is still active.` };
  }
  if (response.status === 429) {
    return { ok: false, error: `${label} could not check the key right now. Try again in a moment.` };
  }
  return {
    ok: false,
    error: detail ? `${label} could not check the key (${response.status}): ${detail}` : `${label} could not check the key (${response.status}).`,
  };
}

function keyCheckRequest(provider: ModelProviderId, apiKey: string): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      };
    case "gemini":
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        headers: { "x-goog-api-key": apiKey },
      };
    default: {
      const unhandled: never = provider;
      throw new Error(`Unknown model supplier ${String(unhandled)}.`);
    }
  }
}

const modelPageLimit = 20;

/**
 * Models the supplier will run for this key. Embeddings, speech, and image models are left out because
 * grouping the map needs a text reply.
 */
export async function listSupplierModels(
  input: { provider: ModelProviderId; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SupplierModelList> {
  const collected: SupplierModel[] = [];
  let url: string | null = modelListUrl(input.provider, null);
  for (let page = 0; page < modelPageLimit && url; page += 1) {
    const loaded = await supplierGet(url, modelListHeaders(input.provider, input.apiKey), input.apiKey, fetchImpl);
    if (!loaded.ok) {
      return loaded;
    }
    const cursor = collectModels(input.provider, loaded.body, collected);
    url = cursor ? modelListUrl(input.provider, cursor) : null;
  }
  return { ok: true, models: sortModels(collected, modelProvider(input.provider).defaultModel) };
}

function modelListUrl(provider: ModelProviderId, cursor: string | null): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1/models";
    case "anthropic":
      return cursor
        ? `https://api.anthropic.com/v1/models?limit=100&after_id=${encodeURIComponent(cursor)}`
        : "https://api.anthropic.com/v1/models?limit=100";
    case "gemini":
      return cursor
        ? `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&pageToken=${encodeURIComponent(cursor)}`
        : "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100";
    default: {
      const unhandled: never = provider;
      throw new Error(`Unknown model supplier ${String(unhandled)}.`);
    }
  }
}

function modelListHeaders(provider: ModelProviderId, apiKey: string): Record<string, string> {
  switch (provider) {
    case "openai":
      return { Authorization: `Bearer ${apiKey}` };
    case "anthropic":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "gemini":
      return { "x-goog-api-key": apiKey };
    default: {
      const unhandled: never = provider;
      throw new Error(`Unknown model supplier ${String(unhandled)}.`);
    }
  }
}

/** Returns the cursor for the next page, or null when the list is finished. */
function collectModels(provider: ModelProviderId, body: unknown, into: SupplierModel[]): string | null {
  const record = asRecord(body);
  if (!record) {
    return null;
  }
  switch (provider) {
    case "openai": {
      const data = Array.isArray(record.data) ? record.data : [];
      for (const item of data) {
        const row = asRecord(item);
        const id = typeof row?.id === "string" ? row.id : "";
        if (id && openAiTextModel(id)) {
          pushModel(into, id, id);
        }
      }
      return null;
    }
    case "anthropic": {
      const data = Array.isArray(record.data) ? record.data : [];
      for (const item of data) {
        const row = asRecord(item);
        const id = typeof row?.id === "string" ? row.id : "";
        const label = typeof row?.display_name === "string" ? row.display_name : id;
        if (id) {
          pushModel(into, id, label);
        }
      }
      return record.has_more === true && typeof record.last_id === "string" && record.last_id ? record.last_id : null;
    }
    case "gemini": {
      const data = Array.isArray(record.models) ? record.models : [];
      for (const item of data) {
        const row = asRecord(item);
        const methods = Array.isArray(row?.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
        const name = typeof row?.name === "string" ? row.name.replace(/^models\//, "") : "";
        const label = typeof row?.displayName === "string" ? row.displayName : name;
        if (name && methods.includes("generateContent")) {
          pushModel(into, name, label);
        }
      }
      return typeof record.nextPageToken === "string" && record.nextPageToken ? record.nextPageToken : null;
    }
    default: {
      const unhandled: never = provider;
      throw new Error(`Unknown model supplier ${String(unhandled)}.`);
    }
  }
}

function openAiTextModel(id: string): boolean {
  return !/embedding|whisper|tts|dall-e|moderation|transcribe|sora|realtime|audio|image/i.test(id);
}

function pushModel(into: SupplierModel[], id: string, label: string): void {
  const trimmed = id.trim();
  if (!modelIdPattern.test(trimmed) || into.some((model) => model.id === trimmed)) {
    return;
  }
  const name = label.trim() || trimmed;
  into.push({ id: trimmed, label: name });
}

function sortModels(models: SupplierModel[], preferred: string): SupplierModel[] {
  return [...models].sort((left, right) => {
    if (left.id === preferred) {
      return -1;
    }
    if (right.id === preferred) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });
}

async function supplierGet(
  url: string,
  headers: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, error: "Could not reach the supplier to load models." };
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = errorDetail(clip(text, apiKey));
    if (response.status === 401 || response.status === 403 || (response.status === 400 && /api[_ ]?key|invalid|unauthor/i.test(detail))) {
      return { ok: false, error: "That key was rejected. Check that it belongs to this supplier and is still active." };
    }
    return { ok: false, error: detail ? `Could not load models (${response.status}): ${detail}` : `Could not load models (${response.status}).` };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "The supplier returned a model list that is not JSON." };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clip(text: string, secret: string): string {
  return text.replaceAll(secret, "[key]").replace(/\s+/g, " ").trim().slice(0, 280);
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.error === "object" && parsed.error?.message) {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // The supplier returned plain text.
  }
  return body.slice(0, 180);
}
