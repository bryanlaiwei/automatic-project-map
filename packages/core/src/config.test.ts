import { describe, expect, it } from "vitest";
import { config } from "./config.js";

describe("server settings", () => {
  it("stays on this machine and API_PORT while developing", () => {
    const settings = config({ API_PORT: "4000" });
    expect(settings.apiHost).toBe("127.0.0.1");
    expect(settings.apiPort).toBe(4000);
    expect(settings.databasePoolMax).toBe(10);
  });

  it("uses the host PORT and listens on every interface in production", () => {
    const settings = config({ PORT: "8080", API_PORT: "4000", NODE_ENV: "production", DATABASE_POOL_MAX: "3" });
    expect(settings.apiHost).toBe("0.0.0.0");
    expect(settings.apiPort).toBe(8080);
    expect(settings.databasePoolMax).toBe(3);
  });

  it("keeps an explicit HOST", () => {
    const settings = config({ HOST: "127.0.0.1", NODE_ENV: "production" });
    expect(settings.apiHost).toBe("127.0.0.1");
  });

  it("rejects a port that is not a positive integer", () => {
    expect(() => config({ PORT: "0" })).toThrow(/PORT must be a positive integer/);
  });
});
