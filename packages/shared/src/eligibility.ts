import { matchingRoot } from "./folders.js";

export const exclusionReasons = [
  "missing_creation_time",
  "created_before_tracking",
  "missing_folder",
  "folder_not_selected",
] as const;

export type ExclusionReason = (typeof exclusionReasons)[number];

export type SessionEligibility =
  | { eligible: true; matchedRoot: string }
  | { eligible: false; reason: ExclusionReason };

export function evaluateSessionEligibility(input: {
  createdAt: string | null;
  trackingStartedAt: string;
  workingFolder: string | null;
  selectedRoots: string[];
}): SessionEligibility {
  if (input.createdAt === null || Number.isNaN(Date.parse(input.createdAt))) {
    return { eligible: false, reason: "missing_creation_time" };
  }

  const createdAt = Date.parse(input.createdAt);
  const trackingStartedAt = Date.parse(input.trackingStartedAt);
  if (Number.isNaN(trackingStartedAt) || createdAt <= trackingStartedAt) {
    return { eligible: false, reason: "created_before_tracking" };
  }

  if (input.workingFolder === null || input.workingFolder.trim() === "") {
    return { eligible: false, reason: "missing_folder" };
  }

  const matchedRoot = matchingRoot(input.workingFolder, input.selectedRoots);
  if (matchedRoot === null) {
    return { eligible: false, reason: "folder_not_selected" };
  }

  return { eligible: true, matchedRoot };
}
