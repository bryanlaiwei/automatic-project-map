// Parsed shape of one agent session: who it belongs to, which folder it used, and the messages read from its log.
// SessionRecord is one user or assistant message. ParsedSession is the whole session.

export type SessionRecord = {
  id: string;
  role: "user" | "assistant";
  text: string;
  occurredAt: string;
};

export type ParsedSession = {
  sessionId: string | null;
  createdAt: string | null;
  workingFolder: string | null;
  sourceVersion: string | null;
  records: SessionRecord[];
  ambiguousFolder: boolean;
};
