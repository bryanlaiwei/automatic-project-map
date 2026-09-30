// The list the scan loops. Adding an agent means appending its adapter here.

import { eventSources, type EventSource } from "@apm/shared";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { cursorAdapter } from "./adapters/cursor.js";
import type { AgentAdapter, SessionAgentId } from "./contract/adapter.js";

export const agents: readonly AgentAdapter[] = [codexAdapter, claudeCodeAdapter, cursorAdapter];

export function agentById(id: SessionAgentId): AgentAdapter {
  const found = agents.find((agent) => agent.id === id);
  if (!found) {
    throw new Error(`No adapter for ${id}.`);
  }
  return found;
}

export function sessionSources(): EventSource[] {
  return eventSources.filter((source) => source !== "github");
}
