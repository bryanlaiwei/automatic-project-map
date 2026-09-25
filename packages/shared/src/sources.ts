// Versions and file shapes checked while writing the day-one readers.
// The collector records the version found inside each session when the file has one.
export const supportedSources = [
  {
    id: "codex",
    testedWith: "Codex CLI 0.130.0 rollout JSONL (codex-tui)",
    format:
      "JSONL. The first useful record is type session_meta and includes payload.timestamp, payload.cwd, payload.id, and payload.cli_version.",
  },
  {
    id: "claude_code",
    testedWith: "Claude Code 2.1.227 project JSONL",
    format:
      "JSONL. user and assistant records include sessionId, timestamp, cwd, uuid, and version. Creation time is the earliest timestamp. Records without a timestamp do not establish creation time.",
  },
  {
    id: "cursor",
    testedWith: "Cursor agent transcript JSONL observed locally on 2026-09-24",
    format:
      "A folder with session.json and transcript.jsonl. The transcript lines have role and message. session.json supplies session_id, created_at, cwd, and cursor_version. A transcript file alone has no creation time, so it is skipped.",
  },
] as const;
