import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AgentRuntime } from "../src/agent-runtime.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { type ClaudeHealth, claudeSelfTest } from "../src/claude/health.ts";
import type { ClaudeRunner } from "../src/claude/runner.ts";
import { runClaude } from "../src/claude/runner.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryOutbox } from "../src/outbox.ts";
import { startWorker } from "../src/worker.ts";
import { createFakeApi, NOW } from "./fake-api.ts";
import { fakeClaude, structuredLines } from "./fake-claude.ts";
import { fakeSocketFactory } from "./fake-socket.ts";

const stateDir = () => mkdtempSync(path.join(tmpdir(), "health-"));
const okRunner: ClaudeRunner = async () => ({
  output: { ok: true },
  text: "",
  model: "claude-opus-5-5",
  cliVersion: "2.1.292",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 1,
    durationApiMs: 1,
    wallMs: 1,
  },
  rateLimit: undefined,
});

const loggedIn = async () => ({
  loggedIn: true,
  authMethod: "claude.ai",
  subscriptionType: "team",
});
const version = async () => "2.1.292";

describe("claudeSelfTest", () => {
  it("reports a missing login without calling Claude", async () => {
    let called = false;
    const health = await claudeSelfTest({
      runner: async (o) => {
        called = true;
        return okRunner(o);
      },
      stateDir: stateDir(),
      authStatus: async () => ({ loggedIn: false }),
      cliVersion: version,
    });
    expect(health.state).toBe("unauthenticated");
    expect(health.message).toContain("Claude oturumu yok/süresi doldu");
    expect(called).toBe(false);
  });

  it("makes the tiny call once and trusts the cache for a while (auto mode)", async () => {
    const dir = stateDir();
    let calls = 0;
    const runner: ClaudeRunner = async (o) => {
      calls++;
      return okRunner(o);
    };
    const first = await claudeSelfTest({
      runner,
      stateDir: dir,
      authStatus: loggedIn,
      cliVersion: version,
    });
    expect(first).toMatchObject({ state: "ok", cliVersion: "2.1.292", subscriptionType: "team" });
    expect(first.callMs).toBeTypeOf("number");
    const second = await claudeSelfTest({
      runner,
      stateDir: dir,
      authStatus: loggedIn,
      cliVersion: version,
    });
    expect(second.state).toBe("ok");
    expect(calls).toBe(1);
    // A new CLI version tests again.
    await claudeSelfTest({
      runner,
      stateDir: dir,
      authStatus: loggedIn,
      cliVersion: async () => "2.2.0",
    });
    expect(calls).toBe(2);
    // `always` ignores the cache, `never` skips the call.
    await claudeSelfTest({
      runner,
      stateDir: dir,
      authStatus: loggedIn,
      cliVersion: version,
      callMode: "always",
    });
    await claudeSelfTest({
      runner,
      stateDir: dir,
      authStatus: loggedIn,
      cliVersion: version,
      callMode: "never",
    });
    expect(calls).toBe(3);
  });

  it("reports a usage limit with its reset time, and an expired token", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000);
    const limited = await claudeSelfTest({
      runner: async () => {
        throw new ClaudeUsageLimitError("limit", resetsAt, "rate_limit_event");
      },
      stateDir: stateDir(),
      authStatus: loggedIn,
      cliVersion: version,
    });
    expect(limited).toMatchObject({ state: "limited", resetsAt: resetsAt.toISOString() });
    const expired = await claudeSelfTest({
      runner: async () => {
        throw new ClaudeError("auth", "OAuth token has expired");
      },
      stateDir: stateDir(),
      authStatus: loggedIn,
      cliVersion: version,
    });
    expect(expired.state).toBe("unauthenticated");
  });

  it("runs the tiny call through the real runner against a fake CLI", async () => {
    const fake = fakeClaude({ lines: structuredLines({ ok: true }) });
    const health = await claudeSelfTest({
      runner: (o) => runClaude(o, { bin: fake.bin, workRoot: stateDir() }),
      stateDir: stateDir(),
      authStatus: loggedIn,
      cliVersion: version,
      callMode: "always",
    });
    expect(health.state).toBe("ok");
    expect(fake.recorded().args).toContain("--json-schema");
  });
});

describe("AgentRuntime announcements", () => {
  function runtime(health: () => ClaudeHealth) {
    const config = loadConfig({ STUDIO_WORKER_ID: "mac", STUDIO_STATE_DIR: stateDir() });
    return new AgentRuntime({
      config,
      settings: loadAgentSettings({}),
      logger: silentLogger,
      api: createFakeApi().api,
      runner: okRunner,
      selfTest: async () => health(),
      recheckIntervalMs: 0,
    });
  }

  it("announces the AI job types only while Claude or Gemini can be used, keeping render/publish active", async () => {
    let state: ClaudeHealth = { state: "unauthenticated", message: "yok", checkedAt: NOW };
    const r = runtime(() => state);
    let changes = 0;
    await r.start(() => changes++);
    expect(r.capabilities(["demo.echo"])).toEqual([
      "demo.echo",
      "content.render",
      "schedule.publish",
      "content.check",
      "media.analyze",
      "insights.sync",
      "comments.sync",
    ]);
    expect(r.versionSuffix()).toBe("+claude.unauthenticated");

    state = { state: "ok", message: "ok", checkedAt: NOW };
    await r.check();
    expect(r.capabilities(["demo.echo"])).toEqual([
      "demo.echo",
      "content.render",
      "schedule.publish",
      "content.check",
      "media.analyze",
      "insights.sync",
      "comments.sync",
      "chat.turn",
      "content.generate",
      "brand.analyze",
      "image.generate",
      "brand.skill_draft",
      "comments.suggest",
      "content.details",
    ]);
    expect(r.versionSuffix()).toBe("");
    expect(changes).toBe(2);

    // A limit keeps the types announced (jobs park) and parks the gate.
    const until = new Date(Date.now() + 600_000);
    state = { state: "limited", message: "sınır", checkedAt: NOW, resetsAt: until.toISOString() };
    await r.check();
    expect(r.capabilities([])).toEqual([
      "content.render",
      "schedule.publish",
      "content.check",
      "media.analyze",
      "insights.sync",
      "comments.sync",
      "chat.turn",
      "content.generate",
      "brand.analyze",
      "image.generate",
      "brand.skill_draft",
      "comments.suggest",
      "content.details",
    ]);
    expect(r.gate.status().parkedUntil?.getTime()).toBe(until.getTime());

    // An auth error seen by a real job takes AI types off again while keeping non-AI types.
    r.markUnauthenticated("401");
    expect(r.capabilities([])).toEqual([
      "content.render",
      "schedule.publish",
      "content.check",
      "media.analyze",
      "insights.sync",
      "comments.sync",
    ]);
    await r.stop();
  });
});

describe("worker with an agent runtime", () => {
  it("announces AI & media types, re-announces on health changes and reports usage to the hub", async () => {
    const config = loadConfig({ STUDIO_WORKER_ID: "mac", STUDIO_STATE_DIR: stateDir() });
    let state: ClaudeHealth = { state: "ok", message: "ok", checkedAt: NOW };
    const agent = new AgentRuntime({
      config,
      settings: loadAgentSettings({}),
      logger: silentLogger,
      api: createFakeApi().api,
      runner: async (o) => ({
        ...(await okRunner(o)),
        rateLimit: {
          status: "allowed",
          rateLimitType: "five_hour",
          unifiedWindows: {
            five_hour: { utilization: 0.42, resetsAt: 1794845400 },
            seven_day: { utilization: 0.1, resetsAt: 1794999600 },
          },
        },
      }),
      selfTest: async () => state,
      recheckIntervalMs: 0,
    });
    await agent.start();
    const fake = fakeSocketFactory();
    const worker = startWorker({
      config,
      logger: silentLogger,
      socketFactory: fake.factory,
      outbox: new MemoryOutbox(),
      agent,
    });
    fake.last()?.simulateOpen();
    expect(fake.last()?.sent[0]).toMatchObject({
      type: "hello",
      capabilities: [
        "demo.echo",
        "content.render",
        "schedule.publish",
        "content.check",
        "media.analyze",
        "insights.sync",
        "comments.sync",
        "chat.turn",
        "content.generate",
        "brand.analyze",
        "image.generate",
        "brand.skill_draft",
        "comments.suggest",
        "content.details",
      ],
      workerVersion: "0.1.0",
    });

    // A Claude call through the gate reports the windows it saw.
    await agent.gate.call({ label: "x", system: "s", content: [] });
    const usage = fake.last()?.sent.find((m) => m.type === "worker.usage");
    expect(usage).toMatchObject({
      type: "worker.usage",
      source: "rate_limit_event",
      windows: [
        { kind: "five_hour", usedPercent: 42, limited: false },
        { kind: "weekly", usedPercent: 10, limited: false },
      ],
    });

    // Login lost: reconnect without the AI types; render & publish stay active.
    state = { state: "unauthenticated", message: "yok", checkedAt: NOW };
    await agent.check();
    const second = fake.last();
    second?.simulateOpen();
    expect(second?.sent[0]).toMatchObject({
      type: "hello",
      capabilities: [
        "demo.echo",
        "content.render",
        "schedule.publish",
        "content.check",
        "media.analyze",
        "insights.sync",
        "comments.sync",
      ],
      workerVersion: "0.1.0+claude.unauthenticated",
    });
    expect(second?.sent.some((m) => m.type === "worker.usage")).toBe(true);
    worker.stop();
  });
});
