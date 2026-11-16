import { describe, expect, it } from "vitest";
import { DEFAULT_STATE_DIR, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({ STUDIO_WORKER_ID: "mac" });
    expect(c).toEqual({
      hubUrl: "ws://127.0.0.1:8787/api/hub",
      token: undefined,
      workerId: "mac",
      concurrency: 1,
      heartbeatIntervalMs: 15_000,
      shutdownTimeoutMs: 10_000,
      stateDir: DEFAULT_STATE_DIR,
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

  it("reads the token, concurrency and state dir", () => {
    const c = loadConfig({
      STUDIO_WORKER_TOKEN: "abc",
      STUDIO_CONCURRENCY: "2",
      STUDIO_STATE_DIR: "/tmp/x",
      STUDIO_HEARTBEAT_INTERVAL_S: "5",
    });
    expect(c).toMatchObject({
      token: "abc",
      concurrency: 2,
      stateDir: "/tmp/x",
      heartbeatIntervalMs: 5000,
    });
    expect(() => loadConfig({ STUDIO_CONCURRENCY: "0" })).toThrow(/Invalid worker configuration/);
  });

  it("rejects a non-WebSocket hub URL", () => {
    expect(() => loadConfig({ STUDIO_HUB_URL: "http://x" })).toThrow(
      /Invalid worker configuration/,
    );
  });
});
