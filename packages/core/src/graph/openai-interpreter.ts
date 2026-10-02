import OpenAI from "openai";
import { config } from "../config.js";
import { zodTextFormat } from "openai/helpers/zod";
import { renderContext, type InterpretationContext } from "./context.js";
import { graphInstructions, graphPromptVersion } from "./graph-prompt.js";
import type { Interpreter } from "./process.js";
import { proposalSchema, type Proposal } from "./proposal.js";

export const defaultOpenAiModel = "gpt-5-nano";

export function createOpenAiInterpreter(input: { apiKey: string; model?: string; client?: OpenAI }): Interpreter {
  const client = input.client ?? new OpenAI({ apiKey: input.apiKey, timeout: 120_000, maxRetries: 2 });
  const model = input.model ?? defaultOpenAiModel;
  return {
    model,
    promptVersion: graphPromptVersion,
    async interpret(context: InterpretationContext): Promise<Proposal> {
      const response = await client.responses.parse({
        model,
        instructions: graphInstructions,
        input: renderContext(context),
        text: { format: zodTextFormat(proposalSchema, "graph_proposal") },
        store: false,
      });
      if (!response.output_parsed) {
        throw new Error(`The model returned no usable proposal (status ${response.status ?? "unknown"}).`);
      }
      return response.output_parsed;
    },
  };
}

/** Reads OPENAI_API_KEY and OPENAI_MODEL; null when no key is configured. */
export function openAiInterpreterFromEnv(env?: NodeJS.ProcessEnv): Interpreter | null {
  const settings = env
    ? { openAiApiKey: env.OPENAI_API_KEY?.trim() || null, openAiModel: env.OPENAI_MODEL?.trim() || null }
    : config();
  if (!settings.openAiApiKey) {
    return null;
  }
  const model = settings.openAiModel;
  return createOpenAiInterpreter({ apiKey: settings.openAiApiKey, ...(model ? { model } : {}) });
}
