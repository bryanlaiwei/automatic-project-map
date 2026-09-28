// Names one session.content_added event from the agent, the session id, and the messages in order.
// The same records keep the same id, and a later change to those records gets a new one.
import { createHash } from "node:crypto";
import type { SessionMessage } from "../schema/events.js";

export function sessionContentEventId(source: string, sessionId: string, records: readonly SessionMessage[]): string {
  const canonical = records
    .map((record) => `${record.id}\u001f${record.role}\u001f${record.occurredAt}\u001f${record.text}`)
    .join("\u001e");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${source}:${sessionId}:content:${digest}`;
}
