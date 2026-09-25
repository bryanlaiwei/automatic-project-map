import { describe, expect, it } from "vitest";
import { evaluateSessionEligibility } from "./index.js";

const trackingStartedAt = "2026-09-24T12:00:00.000Z";
const selectedRoots = ["/Projects/my-app"];

describe("session eligibility", () => {
  it("accepts a session created after tracking when the folder matches", () => {
    expect(
      evaluateSessionEligibility({
        createdAt: "2026-09-24T12:00:01.000Z",
        trackingStartedAt,
        workingFolder: "/Projects/my-app/web",
        selectedRoots,
      }),
    ).toEqual({ eligible: true, matchedRoot: "/Projects/my-app" });
  });

  it("excludes sessions created at or before tracking starts", () => {
    expect(
      evaluateSessionEligibility({
        createdAt: trackingStartedAt,
        trackingStartedAt,
        workingFolder: "/Projects/my-app",
        selectedRoots,
      }).eligible,
    ).toBe(false);
  });

  it("excludes sessions with no reliable creation time", () => {
    const result = evaluateSessionEligibility({
      createdAt: null,
      trackingStartedAt,
      workingFolder: "/Projects/my-app",
      selectedRoots,
    });
    expect(result).toEqual({ eligible: false, reason: "missing_creation_time" });
  });

  it("excludes a missing folder and a folder outside the selection", () => {
    expect(
      evaluateSessionEligibility({
        createdAt: "2026-09-24T13:00:00.000Z",
        trackingStartedAt,
        workingFolder: null,
        selectedRoots,
      }),
    ).toEqual({ eligible: false, reason: "missing_folder" });

    expect(
      evaluateSessionEligibility({
        createdAt: "2026-09-24T13:00:00.000Z",
        trackingStartedAt,
        workingFolder: "/Projects/my-app-copy",
        selectedRoots,
      }),
    ).toEqual({ eligible: false, reason: "folder_not_selected" });
  });
});
