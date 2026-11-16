import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({ STUDIO_WORKER_ID: "mac" });
    expect(c).toEqual({
      hubUrl: "ws://127.0.0.1:8787/api/hub",
      workerId: "mac",
      backoff: { baseMs: 500, maxMs: 30_000, jitter: 0.2 },
      pingIntervalMs: 25_000,
      logLevel: "info",
    });
  });

  it("reads and coerces values", () => {
    const c = loadConfig({
      STUDIO_HUB_URL: "wss://social.example.com/api/hub",
      STUDIO_RECONNECT_BASE_MS: "250",
      STUDIO_RECONNECT_MAX_MS: "5000",
      STUDIO_LOG_LEVEL: "debug",
      STUDIO_RECONNECT_JITTER: "",
    });
    expect(c.hubUrl).toBe("wss://social.example.com/api/hub");
    expect(c.backoff).toEqual({ baseMs: 250, maxMs: 5000, jitter: 0.2 });
    expect(c.logLevel).toBe("debug");
  });

  it("rejects a non-WebSocket hub URL", () => {
    expect(() => loadConfig({ STUDIO_HUB_URL: "http://x" })).toThrow(
      /Invalid worker configuration/,
    );
  });
});
