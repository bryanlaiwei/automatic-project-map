import { z } from "zod";
import { renderContext, type InterpretationContext } from "./context.js";
import { createOpenAiInterpreter, graphInstructions, graphPromptVersion } from "./openai-interpreter.js";
import type { Interpreter } from "./process.js";
import { proposalSchema, type Proposal } from "./proposal.js";
import { modelProvider, type ModelProviderId } from "../model-providers.js";

const proposalJsonSchema = providerJsonSchema();

export function createModelInterpreter(input: {
  provider: ModelProviderId;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Interpreter {
  const model = input.model?.trim() || modelProvider(input.provider).defaultModel;
  const fetchImpl = input.fetchImpl ?? fetch;
  switch (input.provider) {
    case "openai":
      return createOpenAiInterpreter({ apiKey: input.apiKey, ...(model ? { model } : {}) });
    case "anthropic":
      return {
        model,
        promptVersion: graphPromptVersion,
        interpret: (context) => interpretAnthropic({ apiKey: input.apiKey, model, context, fetchImpl }),
      };
    case "gemini":
      return {
        model,
        promptVersion: graphPromptVersion,
        interpret: (context) => interpretGemini({ apiKey: input.apiKey, model, context, fetchImpl }),
      };
    default: {
      const unhandled: never = input.provider;
      throw new Error(`Unknown model supplier ${String(unhandled)}.`);
    }
  }
}

async function interpretAnthropic(input: {
  apiKey: string;
  model: string;
  context: InterpretationContext;
  fetchImpl: typeof fetch;
}): Promise<Proposal> {
  const payload = await postJson({
    url: "https://api.anthropic.com/v1/messages",
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
    body: {
      model: input.model,
      max_tokens: 16_384,
      system: graphInstructions,
      messages: [{ role: "user", content: renderContext(input.context) }],
      tools: [
        {
          name: "graph_proposal",
          description: "Operations that update the project map.",
          input_schema: proposalJsonSchema,
        },
      ],
      tool_choice: { type: "tool", name: "graph_proposal" },
    },
  });
  return anthropicProposal(payload);
}

async function interpretGemini(input: {
  apiKey: string;
  model: string;
  context: InterpretationContext;
  fetchImpl: typeof fetch;
}): Promise<Proposal> {
  const model = input.model.replace(/^models\//, "");
  const payload = await postJson({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    headers: { "x-goog-api-key": input.apiKey },
    body: {
      systemInstruction: { parts: [{ text: graphInstructions }] },
      contents: [{ role: "user", parts: [{ text: renderContext(input.context) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: proposalJsonSchema,
      },
    },
  });
  return geminiProposal(payload);
}

async function postJson(input: {
  url: string;
  apiKey: string;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...input.headers },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new Error(`The model request failed: ${redact(reason, input.apiKey)}`);
  }
  const text = await response.text();
  const safe = redact(text, input.apiKey).replace(/\s+/g, " ").trim().slice(0, 400);
  if (!response.ok) {
    throw new Error(safe ? `The model request failed (${response.status}). ${safe}` : `The model request failed (${response.status}).`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The model returned a response that is not JSON.");
  }
}

function anthropicProposal(payload: unknown): Proposal {
  const blocks = blocksOf(payload);
  const tool = blocks.find((block) => block.type === "tool_use" && block.name === "graph_proposal");
  if (!tool) {
    throw new Error("The model returned no usable proposal.");
  }
  const raw = typeof tool.input === "string" ? parseJsonText(tool.input) : tool.input;
  return parseProposal(raw);
}

function geminiProposal(payload: unknown): Proposal {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("The model returned no usable proposal.");
  }
  const record = payload as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (record.promptFeedback?.blockReason) {
    throw new Error(`The model blocked the request (${record.promptFeedback.blockReason}).`);
  }
  const parts = record.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  if (!text.trim()) {
    throw new Error("The model returned no usable proposal.");
  }
  return parseProposal(parseJsonText(text));
}

type ContentBlock = { type?: string; name?: string; input?: unknown };

function blocksOf(payload: unknown): ContentBlock[] {
  if (typeof payload !== "object" || payload === null || !("content" in payload) || !Array.isArray(payload.content)) {
    return [];
  }
  return payload.content.filter((block): block is ContentBlock => typeof block === "object" && block !== null);
}

function parseProposal(value: unknown): Proposal {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("The model returned a proposal that does not match the expected shape.");
  }
  return parsed.data;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("The model returned text that is not JSON.");
  }
}

function redact(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, "[key]") : text;
}

/** Suppliers other than OpenAI receive JSON Schema. `const` is rewritten to `enum`, which they accept. */
function providerJsonSchema(): Record<string, unknown> {
  const rewritten = rewriteSchema(z.toJSONSchema(proposalSchema));
  if (!isRecord(rewritten)) {
    throw new Error("Proposal schema could not be prepared.");
  }
  return rewritten;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteSchema(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if ("$schema" in record) {
    const { $schema: _schema, ...rest } = record;
    return rewriteSchema(rest);
  }
  if ("const" in record) {
    const { const: constant, ...rest } = record;
    return rewriteSchema({ ...rest, enum: [constant] });
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, rewriteSchema(item)]));
}
