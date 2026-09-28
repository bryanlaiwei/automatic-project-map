import { describe, expect, it } from "vitest";
import { agents, sessionSources } from "../agents.js";

describe("agent registry", () => {
  it("has one adapter for every session source and no extras", () => {
    expect(agents.map((agent) => agent.id).sort()).toEqual([...sessionSources()].sort());
  });
});
