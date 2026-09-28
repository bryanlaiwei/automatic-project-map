// Contract for one coding agent: where its logs live, how to find sessions, and how to parse a byte range.
// The id is an event source other than GitHub, so a new adapter does not compile until its name is in eventSources.

import type { EventSource } from "@apm/shared";
import type { ParsedSession } from "./session.js";

export type SessionAgentId = Exclude<EventSource, "github">;

export type SessionLocator = {
  /** Stable id for the change tracker. One session, even when it is more than one file. */
  key: string;
  /** Files whose size or modification time mean this session changed. */
  files: string[];
  /** File whose byte offset is the checkpoint. */
  logFile: string;
};

export interface AgentAdapter {
  id: SessionAgentId;
  /** Directory to scan. Undefined means this agent is not scanned. */
  logDirectory(env: NodeJS.ProcessEnv, home: string): string | undefined;
  discover(root: string): SessionLocator[];
  /** `logBytes` is the complete-line prefix of `locator.logFile`, or a suffix of it. */
  read(locator: SessionLocator, logBytes: Buffer): ParsedSession;
}
