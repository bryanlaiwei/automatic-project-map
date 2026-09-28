// Re-exports the event schemas and the shared decisions so other packages can import them from @apm/shared.
export { JSON_BODY_LIMIT_BYTES, SCHEMA_VERSION } from "./schema/events.js";
export {
  eventDetailsSchema,
  eventSourceSchema,
  eventSources,
  normalizedEventSchema,
  sessionMessageSchema,
} from "./schema/events.js";
export type { EventDetails, EventSource, NormalizedEvent, SessionMessage } from "./schema/events.js";
export { evaluateSessionEligibility } from "./logic/session-eligibility.js";
export type { ExclusionReason, SessionEligibility } from "./logic/session-eligibility.js";
export { folderMatchesRoot, matchingRoot, normalizeAbsolutePath } from "./logic/selected-folders.js";
export { sessionContentEventId } from "./logic/session-content-id.js";
