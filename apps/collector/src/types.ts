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
