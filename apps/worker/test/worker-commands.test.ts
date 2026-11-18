import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ClaudeAccount, GeminiAccount } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AgentRuntime } from "../src/agent-runtime.ts";
import { startMcpBridge } from "../src/chat/mcp-bridge.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { ClaudeAuthController, extractLoginUrl } from "../src/claude/auth.ts";
import type { ClaudeHealth } from "../src/claude/health.ts";
import type { ClaudeRunner } from "../src/claude/runner.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryOutbox } from "../src/outbox.ts";
import { startWorker } from "../src/worker.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";
import { fakeSocketFactory } from "./fake-socket.ts";

const tempStateDir = () => mkdtempSync(path.join(tmpdir(), "cmd-state-"));

const okClaudeRunner: ClaudeRunner = async () => ({
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

function fakeChildProcess() {
  const emitter = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = () => {
    emitter.signalCode = "SIGTERM";
    emitter.emit("close", 143);
    return true;
  };
  return emitter;
}

describe("ClaudeAuthController", () => {
  it("extracts OAuth login URLs stripping ANSI codes", () => {
    expect(
      extractLoginUrl(
        "\x1b[32mBrowser didn't open? Visit https://claude.ai/oauth/authorize?code=true&state=abc123.\x1b[0m",
      ),
    ).toBe("https://claude.ai/oauth/authorize?code=true&state=abc123");
  });

  it("transitions signed_out -> signing_in -> loginUrl -> signed_in and triggers onLoginComplete", async () => {
    let signedIn = false;
    let loginCompletedCount = 0;
    const child = fakeChildProcess();
    const updates: ClaudeAccount[] = [];

    const controller = new ClaudeAuthController({
      probe: async () =>
        signedIn
          ? {
              cliVersion: "2.1.292",
              loggedIn: true,
              email: "owner@studio.example",
              subscriptionType: "max",
            }
          : {
              cliVersion: "2.1.292",
              loggedIn: false,
            },
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      onLoginComplete: () => {
        loginCompletedCount++;
      },
    });
    controller.onUpdate((acc) => updates.push(acc));

    const initial = await controller.refresh();
    expect(initial.status).toBe("signed_out");

    const started = controller.startLogin();
    expect(started.status).toBe("signing_in");
    expect(started.loginUrl).toBeNull();

    child.stdout.write("Opening browser: https://claude.ai/oauth/authorize?client_id=xyz\n");
    expect(controller.latest()).toMatchObject({
      status: "signing_in",
      loginUrl: "https://claude.ai/oauth/authorize?client_id=xyz",
    });

    signedIn = true;
    child.exitCode = 0;
    child.emit("close", 0);

    await vi.waitFor(() => expect(loginCompletedCount).toBe(1));
    expect(controller.latest()).toMatchObject({
      status: "signed_in",
      email: "owner@studio.example",
      plan: "Claude Max",
      cliVersion: "2.1.292",
      loginUrl: null,
    });
    expect(updates.map((u) => u.status)).toEqual([
      "signed_out",
      "signing_in",
      "signing_in",
      "signed_in",
    ]);
  });
});

describe("McpBridge HTTP auth & dispatch", () => {
  it("enforces Bearer token auth and dispatches tools/list + tools/call", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const writer = new TurnWriter({ api, runId: "run_1", attempt: 1 });
    const executor = new StudioToolExecutor({
      api,
      writer,
      runId: "run_1",
      conversationId: "conv_1",
      initialBrandId: "brand_1",
      initialOpenPlan: null,
      aliases: [],
      signal: new AbortController().signal,
    });
    const bridge = await startMcpBridge(executor, { workRoot: tempStateDir() });
    try {
      const unauth = await bridge.dispatchHttp(undefined, { action: "list" });
      expect(unauth.status).toBe(401);

      const wrongToken = await bridge.dispatchHttp("Bearer wrong", { action: "list" });
      expect(wrongToken.status).toBe(401);

      const listed = await bridge.dispatchHttp(`Bearer ${bridge.token}`, { action: "list" });
      expect(listed.status).toBe(200);
      expect((listed.body.tools as { name: string }[]).map((t) => t.name)).toContain(
        "propose_plan",
      );

      const called = await bridge.dispatchHttp(`Bearer ${bridge.token}`, {
        action: "call",
        name: "list_brands",
        arguments: {},
        callId: "req_1",
      });
      expect(called.status).toBe(200);
      expect(called.body.isError).toBe(false);
      expect(state.parts[0]).toMatchObject({
        type: "tool_step",
        name: "list_brands",
        state: "done",
      });
    } finally {
      await bridge.close();
    }
  });
});

describe("worker.claude, worker.gemini & worker.command over HubConnection", () => {
  it("announces chat.turn via Gemini while Claude is signed out, sends worker.claude/gemini, and handles claude.login + gemini.status", async () => {
    const config = loadConfig({ STUDIO_WORKER_ID: "mac", STUDIO_STATE_DIR: tempStateDir() });
    const settings = loadAgentSettings({ GEMINI_API_KEY: "fake-gemini-key" });

    let claudeLoggedIn = false;
    let claudeHealth: ClaudeHealth = {
      state: "unauthenticated",
      message: "Claude oturumu kapalı",
      checkedAt: NOW,
    };
    let geminiMode: "api" | "both" = "api";
    const loginChild = fakeChildProcess();

    const agent = new AgentRuntime({
      config,
      settings,
      logger: silentLogger,
      api: createFakeApi().api,
      runner: okClaudeRunner,
      selfTest: async () => claudeHealth,
      claudeProbe: async () => ({
        cliVersion: "2.1.292",
        loggedIn: claudeLoggedIn,
        ...(claudeLoggedIn ? { email: "deniz@studio.local", subscriptionType: "max" } : {}),
      }),
      claudeLoginSpawn: (() => loginChild) as unknown as typeof import("node:child_process").spawn,
      geminiHealthCheck: async (): Promise<GeminiAccount> => ({
        status: "ready",
        mode: geminiMode,
        apiKeyConfigured: true,
        cliVersion: geminiMode === "both" ? "0.9.2" : null,
        defaultModel: "gemini-2.5-flash-lite",
        detail: `Gemini hazır (${geminiMode})`,
        checkedAt: new Date().toISOString(),
      }),
      recheckIntervalMs: 0,
    });

    await agent.start();
    // Crucial capability rule: Claude is signed out, Gemini is ready -> ALL job types are announced!
    expect(agent.capabilities(["demo.echo"])).toEqual([
      "demo.echo",
      "content.render",
      "schedule.publish",
      "content.check",
      "chat.turn",
      "content.generate",
      "brand.analyze",
      "image.generate",
      "brand.skill_draft",
    ]);

    const fake = fakeSocketFactory();
    const worker = startWorker({
      config,
      logger: silentLogger,
      socketFactory: fake.factory,
      outbox: new MemoryOutbox(),
      agent,
    });

    const firstSocket = fake.last();
    firstSocket?.simulateOpen();

    expect(firstSocket?.sent[0]).toMatchObject({
      type: "hello",
      capabilities: [
        "demo.echo",
        "content.render",
        "schedule.publish",
        "content.check",
        "chat.turn",
        "content.generate",
        "brand.analyze",
        "image.generate",
        "brand.skill_draft",
      ],
    });
    expect(firstSocket?.sent.find((m) => m.type === "worker.claude")).toMatchObject({
      type: "worker.claude",
      account: { status: "signed_out", cliVersion: "2.1.292" },
    });
    expect(firstSocket?.sent.find((m) => m.type === "worker.gemini")).toMatchObject({
      type: "worker.gemini",
      account: { status: "ready", mode: "api", apiKeyConfigured: true },
    });

    // Hub sends `gemini.status` command -> worker re-checks Gemini and emits updated `worker.gemini`
    geminiMode = "both";
    firstSocket?.simulateMessage({ type: "worker.command", command: "gemini.status" });
    await vi.waitFor(() => {
      const gemFrames = firstSocket?.sent.filter((m) => m.type === "worker.gemini") ?? [];
      expect(gemFrames.at(-1)).toMatchObject({
        type: "worker.gemini",
        account: { mode: "both", cliVersion: "0.9.2" },
      });
    });

    // Hub sends `claude.login` command -> worker emits `signing_in`, then `loginUrl`, then re-announces with `content.generate`!
    firstSocket?.simulateMessage({ type: "worker.command", command: "claude.login" });
    await vi.waitFor(() => {
      const claudeFrames = firstSocket?.sent.filter((m) => m.type === "worker.claude") ?? [];
      expect(claudeFrames.at(-1)).toMatchObject({
        type: "worker.claude",
        account: { status: "signing_in" },
      });
    });

    loginChild.stdout.write("Sign in at https://claude.ai/oauth/authorize?state=test99\n");
    await vi.waitFor(() => {
      const claudeFrames = firstSocket?.sent.filter((m) => m.type === "worker.claude") ?? [];
      expect(claudeFrames.at(-1)).toMatchObject({
        type: "worker.claude",
        account: {
          status: "signing_in",
          loginUrl: "https://claude.ai/oauth/authorize?state=test99",
        },
      });
    });

    claudeLoggedIn = true;
    claudeHealth = { state: "ok", message: "ok", checkedAt: NOW, cliVersion: "2.1.292" };
    loginChild.exitCode = 0;
    loginChild.emit("close", 0);

    // Health state changed (unauthenticated -> ok) -> worker reconnected & re-announced!
    await vi.waitFor(() => expect(fake.sockets.length).toBeGreaterThanOrEqual(2));
    const reconnected = fake.last();
    reconnected?.simulateOpen();
    expect(reconnected?.sent[0]).toMatchObject({
      type: "hello",
      capabilities: [
        "demo.echo",
        "content.render",
        "schedule.publish",
        "content.check",
        "chat.turn",
        "content.generate",
        "brand.analyze",
        "image.generate",
        "brand.skill_draft",
      ],
      workerVersion: "0.1.0",
    });
    expect(reconnected?.sent.find((m) => m.type === "worker.claude")).toMatchObject({
      type: "worker.claude",
      account: {
        status: "signed_in",
        email: "deniz@studio.local",
        plan: "Claude Max",
      },
    });

    // Hub sends `claude.status` -> worker refreshes Claude status and sends `worker.claude`
    const countBefore = reconnected?.sent.filter((m) => m.type === "worker.claude").length ?? 0;
    reconnected?.simulateMessage({ type: "worker.command", command: "claude.status" });
    await vi.waitFor(() => {
      const countAfter = reconnected?.sent.filter((m) => m.type === "worker.claude").length ?? 0;
      expect(countAfter).toBeGreaterThanOrEqual(countBefore);
    });

    worker.stop();
  });
});
