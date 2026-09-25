export { SCHEMA_VERSION } from "./events.js";
export {
  eventDetailsSchema,
  eventSourceSchema,
  eventSources,
  normalizedEventSchema,
  sessionMessageSchema,
} from "./events.js";
export type { EventDetails, EventSource, NormalizedEvent, SessionMessage } from "./events.js";
export { evaluateSessionEligibility } from "./eligibility.js";
export type { ExclusionReason, SessionEligibility } from "./eligibility.js";
export { folderMatchesRoot, matchingRoot, normalizeAbsolutePath } from "./folders.js";
export { supportedSources } from "./sources.js";
