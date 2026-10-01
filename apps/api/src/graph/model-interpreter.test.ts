import { describe, expect, it } from "vitest";
import type { InterpretationContext } from "./context.js";
import { createModelInterpreter } from "./model-interpreter.js";
import { graphPromptVersion } from "./graph-prompt.js";
import { checkModelKey, listSupplierModels } from "../model-providers.js";

const context: InterpretationContext = {
  project: { owner: "acme", name: "app" },
  baseRevision: 0,
  evidence: [],
  workItems: [],
  features: [],
  earlier: [],
};

const key = "sk-test-model-key-0001";

describe("model interpreters", () => {
  it("uses the requested OpenAI model", () => {
    const interpreter = createModelInterpreter({ provider: "openai", apiKey: key, model: "gpt-5-mini" });
    expect(interpreter.model).toBe("gpt-5-mini");
    expect(interpreter.promptVersion).toBe(graphPromptVersion);
    expect(createModelInterpreter({ provider: "openai", apiKey: key }).model).toBe("gpt-5-nano");
  });

  it("reads an Anthropic tool call", async () => {
    let schema = "";
    const interpreter = createModelInterpreter({
      provider: "anthropic",
      apiKey: key,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
        expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
        const body = JSON.parse(String(init?.body)) as { tools: Array<{ input_schema: unknown }> };
        schema = JSON.stringify(body.tools[0]?.input_schema);
        return Response.json({ content: [{ type: "tool_use", name: "graph_proposal", input: { operations: [] } }] });
      },
    });
    expect(interpreter.model).toBe("claude-haiku-4-5");
    await expect(interpreter.interpret(context)).resolves.toEqual({ operations: [] });
    expect(schema).not.toContain("$schema");
    expect(schema).toContain("create_feature");
  });

  it("reads Gemini JSON", async () => {
    const interpreter = createModelInterpreter({
      provider: "gemini",
      apiKey: key,
      model: "gemini-2.5-pro",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(key);
        return Response.json({
          candidates: [{ content: { parts: [{ text: "{\"operations\":[]}" }] } }],
        });
      },
    });
    expect(interpreter.model).toBe("gemini-2.5-pro");
    await expect(interpreter.interpret(context)).resolves.toEqual({ operations: [] });
  });

  it("rejects a proposal that does not match the shape", async () => {
    const interpreter = createModelInterpreter({
      provider: "gemini",
      apiKey: key,
      fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: "{\"operations\":[{}]}" }] } }] }),
    });
    await expect(interpreter.interpret(context)).rejects.toThrow(/does not match/);
  });

  it("reports a blocked Gemini request", async () => {
    const interpreter = createModelInterpreter({
      provider: "gemini",
      apiKey: key,
      fetchImpl: async () => Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    await expect(interpreter.interpret(context)).rejects.toThrow(/SAFETY/);
  });
});

describe("model key checks", () => {
  it("accepts a key the supplier accepts", async () => {
    const result = await checkModelKey({ provider: "anthropic", apiKey: key, model: "claude-haiku-4-5" }, async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/models");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
      return new Response("{}", { status: 200 });
    });
    expect(result).toEqual({ ok: true });
  });

  it("redacts the key from a supplier error", async () => {
    const result = await checkModelKey(
      { provider: "openai", apiKey: key, model: "gpt-5-nano" },
      async () => new Response(`bad ${key}`, { status: 500 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(key);
      expect(result.error).toContain("[key]");
    }
  });

  it("says when the supplier cannot be reached", async () => {
    const result = await checkModelKey({ provider: "gemini", apiKey: key, model: "gemini-2.5-flash" }, async () => {
      throw new Error("offline");
    });
    expect(result).toEqual({ ok: false, error: "Could not reach Gemini to check the key." });
  });

  it("turns an invalid-key response into a short message", async () => {
    const result = await checkModelKey({ provider: "gemini", apiKey: key, model: "gemini-2.5-flash" }, async () =>
      new Response(JSON.stringify({ error: { message: `API key not valid. Please pass a valid API key. ${key}` } }), { status: 400 }),
    );
    expect(result).toEqual({
      ok: false,
      error: "Gemini rejected that key. Check that it belongs to this supplier and is still active.",
    });
  });
});

describe("supplier model lists", () => {
  it("keeps OpenAI text models and drops embeddings and speech", async () => {
    const listed = await listSupplierModels({ provider: "openai", apiKey: key }, async () =>
      Response.json({
        data: [{ id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-5-mini" }, { id: "gpt-5-nano" }, { id: "tts-1" }],
      }),
    );
    expect(listed).toEqual({
      ok: true,
      models: [
        { id: "gpt-5-nano", label: "gpt-5-nano" },
        { id: "gpt-5-mini", label: "gpt-5-mini" },
      ],
    });
  });

  it("follows Anthropic pages", async () => {
    const listed = await listSupplierModels({ provider: "anthropic", apiKey: key }, async (url, init) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
      const href = String(url);
      if (!href.includes("after_id")) {
        return Response.json({
          data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
          has_more: true,
          last_id: "claude-sonnet-4-5",
        });
      }
      return Response.json({
        data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
        has_more: false,
      });
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.models.map((model) => model.id)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
      expect(listed.models[0]?.label).toBe("Claude Haiku 4.5");
    }
  });

  it("lists Gemini models that can generate text", async () => {
    const listed = await listSupplierModels({ provider: "gemini", apiKey: key }, async (url) => {
      expect(String(url)).not.toContain(key);
      return Response.json({
        models: [
          { name: "models/gemini-embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.models.map((model) => model.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    }
  });

  it("does not echo a rejected key", async () => {
    const listed = await listSupplierModels({ provider: "openai", apiKey: key }, async () => new Response(`no ${key}`, { status: 401 }));
    expect(listed.ok).toBe(false);
    if (!listed.ok) {
      expect(listed.error).not.toContain(key);
    }
  });
});
