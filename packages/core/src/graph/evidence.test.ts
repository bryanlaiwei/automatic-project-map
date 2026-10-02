import { evidenceRowChars } from "@apm/shared";
import { describe, expect, it } from "vitest";
import { pullRequestExcerpts, sessionExcerpts } from "./evidence.js";

describe("evidence rows", () => {
  it("keeps a long session message and starts a new row when the next one would pass the cap", () => {
    const long = "a".repeat(evidenceRowChars);
    const parts = sessionExcerpts([
      { id: "1", role: "user", text: long, occurredAt: "2026-09-24T13:00:01.000Z" },
      { id: "2", role: "assistant", text: "next", occurredAt: "2026-09-24T13:00:02.000Z" },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0]?.excerpt).toContain(long);
    expect(parts[1]?.excerpt).toContain("next");
    expect(parts.map((part) => part.excerpt).join("")).not.toContain("…");
  });

  it("splits a long pull request across rows without dropping description, commits, or files", () => {
    const body = "b".repeat(evidenceRowChars * 2);
    const commits = Array.from({ length: 20 }, (_, index) => ({ message: `commit ${index}` }));
    const files = Array.from({ length: 40 }, (_, index) => ({ filename: `file-${index}.ts` }));
    const parts = pullRequestExcerpts({
      number: 7,
      title: "Ship the map",
      body,
      commits,
      files,
    });
    const combined = parts.join("");

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= evidenceRowChars)).toBe(true);
    expect(combined).toContain(body);
    expect(combined).toContain("commit 19");
    expect(combined).toContain("file-39.ts");
  });
});
