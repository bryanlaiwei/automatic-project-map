import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./index.js";

describe("shared package", () => {
  it("exposes the event schema version", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
