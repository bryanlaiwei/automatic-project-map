---
name: onboard-agent
description: Add support for a new local coding agent in the local collector. Use when adding an agent adapter, a new session log format, or support for Codex, Claude Code, Cursor, or another agent.
---

# Onboard a coding agent

The scan loops `agents` in `apps/local-collector/src/agents.ts`. It does not contain a branch per agent. A new agent is one adapter file, one line in that array, and one name in the shared event sources.

## Add the source name first

In `packages/shared/src/schema/events.ts`, add the agent id to `eventSources`. Keep `"github"` in that list. Do not add the id to a database check. `sessions.source` is plain text.

`SessionAgentId` is every `EventSource` except `"github"`. The adapter's `id` must be that type, so it does not compile until the name is in `eventSources`.

## Write the adapter

Add `apps/local-collector/src/adapters/<agent>.ts` that exports an `AgentAdapter` from `apps/local-collector/src/contract/adapter.ts`.

- `logDirectory` returns the default log directory, or `undefined` when the agent is not scanned.
- `discover` returns one `SessionLocator` per session. `logFile` is the file whose byte offset is the checkpoint. `files` are the files whose size or modification time mean the session changed. `key` is the string stored as the checkpoint locator. For a single `.jsonl` file, `key` and `logFile` are that file. For a directory of files, `key` is the directory.
- `read` parses `logBytes`. Those bytes are either the complete lines of `logFile` or the bytes after the saved offset. Read any other file in `locator.files` from disk when the new bytes are not enough, as Cursor does with `session.json`.
- `readPath` reads the path the one-file parse command receives.

Use `textFromContent` from `apps/local-collector/src/message-text.ts` so hidden reasoning and tool output are dropped. Return a `ParsedSession`. Leave `createdAt` null when the log has no reliable creation time.

Append the object to `agents` in `apps/local-collector/src/agents.ts`.

## Test

Add a fixture log and a test that `read` or `readPath` returns the session id, creation time, working folder, and messages. `apps/local-collector/src/test/agents.test.ts` already fails when `eventSources` and `agents` disagree. Do not add a switch in `find-sessions.ts`, `read-after-offset.ts`, `collection-pass.ts`, `collector-loop.ts`, or `parse-file.ts`.
