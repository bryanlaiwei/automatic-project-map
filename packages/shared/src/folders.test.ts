import { describe, expect, it } from "vitest";
import { folderMatchesRoot, matchingRoot, normalizeAbsolutePath } from "./index.js";

describe("folder matching", () => {
  it("matches the selected root and folders inside it", () => {
    expect(folderMatchesRoot("/Projects/my-app", "/Projects/my-app")).toBe(true);
    expect(folderMatchesRoot("/Projects/my-app/frontend", "/Projects/my-app")).toBe(true);
  });

  it("does not match a sibling whose name only starts with the root", () => {
    expect(folderMatchesRoot("/Projects/my-app-copy", "/Projects/my-app")).toBe(false);
    expect(folderMatchesRoot("/Projects/other-app", "/Projects/my-app")).toBe(false);
  });

  it("rejects missing and relative folders", () => {
    expect(normalizeAbsolutePath("")).toBe(null);
    expect(folderMatchesRoot("my-app", "/Projects/my-app")).toBe(false);
  });

  it("compares path parts, so a trailing slash still matches", () => {
    expect(folderMatchesRoot("/Projects/my-app/", "/Projects/my-app")).toBe(true);
  });

  it("returns one root when a parent and a child are both selected", () => {
    expect(
      matchingRoot("/Projects/my-app/frontend/src", ["/Projects/my-app", "/Projects/my-app/frontend"]),
    ).toBe("/Projects/my-app/frontend");
  });
});
