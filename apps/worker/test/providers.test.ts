import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiProviderStatus, Job, Message, TurnContext } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AiUsageRecorder } from "../src/ai/usage-recorder.ts";
import { createChatTurnHandler, resolveChatRoute } from "../src/chat/turn.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { callGeminiJson, geminiKeySource, getGeminiApiKey } from "../src/gemini/json-call.ts";
import { geminiCostUsd, geminiPriceFor, sampleFromMetadata } from "../src/gemini/pricing.ts";
import { silentLogger } from "../src/log.ts";
import { probeAntigravity, runAntigravityTurn } from "../src/providers/antigravity.ts";
import type { CmdResult, CmdRunner } from "../src/providers/cli.ts";
import { ProviderError } from "../src/providers/cli.ts";
import { codexExecArgs, probeCodex } from "../src/providers/codex.ts";
import { pickOpenAiModel, runOpenAiTurn } from "../src/providers/openai.ts";
import { ProvidersController } from "../src/providers/status.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, fakeRun, NOW } from "./fake-api.ts";

// --- helpers -------------------------------------------------------------------------------------

function userMsg(text: string): Message {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "user",
    status: "complete",
    runId: null,
    parts: [{ type: "text", text }],
    mentions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function context(model: string): TurnContext {
  return {
    run: fakeRun({ model }),
    conversation: {
      id: "conv_1",
      brandId: "brand_1",
      title: "Test",
      status: "active",
      activeRunId: "run_1",
      lastSeq: 1,
      agentSession: null,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    brand: fakeBrand(),
    brandProfile: null,
    messages: [userMsg("Markalarımı kontrol et")],
    messagesTruncated: false,
    assets: [],
    openPlan: null,
    assistantMessage: null,
    aliases: [],
    messageCount: 1,
  };
}

function jobCtx(): JobContext {
  const job: Job = {
    id: "job_1",
    type: "chat.turn",
    status: "running",
    payload: { conversationId: "conv_1", runId: "run_1" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: "job_1",
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

const unusedGate = () =>
  new ClaudeGate({
    runner: async () => {
      throw new Error("claude should not run");
    },
  });

function ready(provider: AiProviderStatus["provider"], tools = true): AiProviderStatus {
  return {
    provider,
    state: "ready",
    account: "test",
    cliVersion: "1.0.0",
    defaultModel: null,
    models: [],
    loginUrl: null,
    tools,
    detail: null,
    checkedAt: NOW,
  };
}

/** A fake CLI: `bin` runs `impl` (an .mjs) with node. */
function fakeCli(name: string, impl: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `fake-${name}-`));
  const script = path.join(dir, `${name}.mjs`);
  writeFileSync(script, impl);
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const cmd = (out: Partial<CmdResult>): CmdResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  notFound: false,
  timedOut: false,
  ...out,
});

// --- Gemini pricing and spend ---------------------------------------------------------------------

describe("Gemini pricing", () => {
  it("prices by the longest model prefix, thinking at the output rate, cached input cheaper", () => {
    expect(geminiPriceFor("gemini-2.5-flash-lite-preview-09-2025")?.input).toBe(0.1);
    expect(geminiPriceFor("models/gemini-2.5-flash-001")?.input).toBe(0.3);
    expect(geminiPriceFor("gemini-9-unknown")).toBeNull();
    // 1M prompt (200k cached) + 100k output + 50k thinking on 2.5 Flash:
    const usd = geminiCostUsd({
      model: "gemini-2.5-flash",
      promptTokens: 1_000_000,
      cachedTokens: 200_000,
      candidatesTokens: 100_000,
      thoughtsTokens: 50_000,
    });
    expect(usd).toBeCloseTo(0.8 * 0.3 + 0.2 * 0.03 + 0.15 * 2.5, 9);
  });

  it("applies scheduled price changes and long-context rates", () => {
    const sample = {
      model: "gemini-4-carbon",
      promptTokens: 1_000_000,
      cachedTokens: 0,
      candidatesTokens: 0,
      thoughtsTokens: 0,
    };
    expect(geminiCostUsd(sample, new Date("2026-11-30T12:00:00Z"))).toBeCloseTo(2, 9);
    expect(geminiCostUsd(sample, new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(4, 9);
    const long = { ...sample, model: "gemini-2.5-pro", promptTokens: 300_000 };
    expect(geminiCostUsd(long)).toBeCloseTo(0.3 * 2.5, 9);
    expect(geminiCostUsd({ ...long, promptTokens: 100_000 })).toBeCloseTo(0.1 * 1.25, 9);
  });

  it("prices image output tokens and audio input separately", () => {
    const image = sampleFromMetadata("gemini-nano-banana-2.1", {
      promptTokenCount: 1_000,
      candidatesTokenCount: 1_290,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1_290 }],
    });
    expect(geminiCostUsd(image)).toBeCloseTo((1_000 * 1.5 + 1_290 * 30) / 1e6, 9);
    const audio = sampleFromMetadata("gemini-2.5-flash", {
      promptTokenCount: 1_000_000,
      promptTokensDetails: [
        { modality: "AUDIO", tokenCount: 600_000 },
        { modality: "VIDEO", tokenCount: 400_000 },
      ],
    });
    expect(geminiCostUsd(audio)).toBeCloseTo(0.6 * 1 + 0.4 * 0.3, 9);
  });

  it("batches usage records to the API and retries after a failure", async () => {
    const sent: unknown[][] = [];
    let fail = true;
    const recorder = new AiUsageRecorder({
      api: {
        client: {
          workerAi: {
            reportUsage: async (input: { records: unknown[] }) => {
              if (fail) {
                fail = false;
                throw new Error("offline");
              }
              sent.push(input.records);
              return { stored: input.records.length };
            },
          },
        } as never,
      },
      logger: silentLogger,
      flushDelayMs: 60_000,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const sample = {
      model: "gemini-2.5-flash-lite",
      promptTokens: 1000,
      cachedTokens: 0,
      candidatesTokens: 100,
      thoughtsTokens: 0,
    };
    recorder.gemini(sample, { kind: "chat", jobId: "job_1", runId: "run_1" });
    recorder.gemini({ ...sample, model: "gemini-unknown" }, { kind: "image" });
    await recorder.flush();
    expect(sent).toHaveLength(0);
    expect(recorder.pending()).toBe(2);
    await recorder.flush();
    expect(sent[0]).toEqual([
      expect.objectContaining({
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        kind: "chat",
        jobId: "job_1",
        runId: "run_1",
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: expect.closeTo((1000 * 0.1 + 100 * 0.4) / 1e6, 12),
        pricingVersion: "2026-11-18",
      }),
      expect.objectContaining({ model: "gemini-unknown", costUsd: null, jobId: null }),
    ]);
    await recorder.stop();
  });

  it("reports the tokens of a structured Gemini call", async () => {
    const samples: unknown[] = [];
    await callGeminiJson({
      apiKey: "k-0123456789",
      modelId: "gemini-2.5-flash",
      system: "s",
      content: [{ type: "text", text: "x" }],
      onUsage: (s) => samples.push(s),
      fetch: async () =>
        Response.json({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
          modelVersion: "gemini-2.5-flash-002",
        }),
    });
    expect(samples).toEqual([
      expect.objectContaining({
        model: "gemini-2.5-flash-002",
        promptTokens: 10,
        candidatesTokens: 5,
        thoughtsTokens: 7,
      }),
    ]);
  });
});

describe("Gemini key from the vault", () => {
  it("prefers the stored key over .env and falls back to .env", () => {
    const settings = loadAgentSettings({ GEMINI_API_KEY: "env-key-123456" });
    expect(getGeminiApiKey(settings)).toBe("env-key-123456");
    expect(geminiKeySource(settings)).toBe("env");
    settings.vault = { gemini: { apiKey: "vault-key-abcdef", models: [] } };
    expect(getGeminiApiKey(settings)).toBe("vault-key-abcdef");
    expect(geminiKeySource(settings)).toBe("vault");
    settings.vault = {};
    expect(getGeminiApiKey(settings)).toBe("env-key-123456");
    expect(geminiKeySource(loadAgentSettings({}))).toBeNull();
  });
});

// --- Codex CLI ------------------------------------------------------------------------------------

describe("Codex CLI", () => {
  it("reads install and sign-in state without passing the raw status on", async () => {
    const runner = (status: Partial<CmdResult>): CmdRunner =>
      (async (_bin: string, args: string[]) =>
        args[0] === "--version"
          ? cmd({ stdout: "codex-cli 0.169.1\n" })
          : cmd(status)) as CmdRunner;
    expect(
      await probeCodex("codex", {}, runner({ stderr: "Not logged in", code: 1 })),
    ).toMatchObject({
      installed: true,
      version: "0.169.1",
      loggedIn: false,
    });
    expect(
      await probeCodex("codex", {}, runner({ stdout: "Logged in using ChatGPT\n" })),
    ).toMatchObject({ loggedIn: true, method: "chatgpt" });
    const apiKey = await probeCodex(
      "codex",
      {},
      runner({ stdout: "Logged in using an API key - sk-proj-***abcd\n" }),
    );
    expect(apiKey).toMatchObject({ loggedIn: true, method: "api_key" });
    expect(JSON.stringify(apiKey)).not.toContain("sk-proj");
    const missing = await probeCodex("codex", {}, (async () =>
      cmd({ notFound: true, code: 1 })) as CmdRunner);
    expect(missing.installed).toBe(false);
  });

  it("runs codex exec headless with Studio's MCP bridge and isolates the owner's config", () => {
    const args = codexExecArgs({
      bin: "codex",
      parentEnv: {},
      model: "gpt-6-sol",
      effort: "xhigh",
      system: "s",
      prompt: "p",
      cwd: "/tmp/turn",
      bridge: { scriptPath: "/tmp/turn/studio-mcp.mjs" } as never,
    });
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).toContain('mcp_servers.studio.args=["/tmp/turn/studio-mcp.mjs"]');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('approval_policy="never"');
    expect(args.at(-1)).toBe("-");
  });

  it("answers a chat turn through codex exec --json, calling a Studio tool over the bridge", async () => {
    const bin = fakeCli(
      "codex",
      `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const conf = (key) => {
  const i = args.findIndex((a, j) => args[j - 1] === "-c" && a.startsWith(key + "="));
  return i === -1 ? undefined : JSON.parse(args[i].slice(key.length + 1));
};
if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) { console.error("leaked key"); process.exit(3); }
const command = conf("mcp_servers.studio.command");
const mcpArgs = conf("mcp_servers.studio.args");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "thread.started", thread_id: "th_1" });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Markalara bakıyorum." } });
  const child = spawn(command, mcpArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        child.stdin.end();
        out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: stdin.includes("Markalarımı") ? "Bir marka var." : "?" } });
        out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } });
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_brands", arguments: {} } }) + "\\n");
});
`,
    );
    const { api, state } = createFakeApi({ context: context("codex"), brands: [fakeBrand()] });
    const settings = loadAgentSettings({ STUDIO_CODEX_BIN: bin });
    const out = await createChatTurnHandler({
      api,
      gate: unusedGate(),
      settings,
      logger: silentLogger,
      health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
      providers: () => [ready("codex")],
      stateDir: mkdtempSync(path.join(tmpdir(), "codex-state-")),
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

    expect(out).toMatchObject({ provider: "codex", model: "codex" });
    expect(state.parts.map((p) => p.type)).toEqual(["text", "tool_step", "text"]);
    expect(state.parts[1]).toMatchObject({ type: "tool_step", name: "list_brands", state: "done" });
    expect(state.parts[2]).toEqual({ type: "text", text: "\n\nBir marka var." });
    expect(state.completed[0]).toMatchObject({
      usage: expect.objectContaining({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 20,
        runner: "codex-cli",
      }),
    });
  });

  it("fails the turn with a sign-in hint when Codex is signed out", async () => {
    const bin = fakeCli(
      "codex",
      `process.stdin.resume(); process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }) + "\\n");
});`,
    );
    const { api, state } = createFakeApi({ context: context("codex") });
    const run = createChatTurnHandler({
      api,
      gate: unusedGate(),
      settings: loadAgentSettings({ STUDIO_CODEX_BIN: bin }),
      logger: silentLogger,
      health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
      providers: () => [ready("codex")],
      stateDir: mkdtempSync(path.join(tmpdir(), "codex-state-")),
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    expect(JSON.stringify(state.failed[0])).toContain("Codex oturumu kapalı");
  });
});

// --- OpenAI API -----------------------------------------------------------------------------------

describe("OpenAI API (Responses)", () => {
  it("picks the configured model, else a preferred model the key lists", () => {
    expect(pickOpenAiModel("gpt-x", ["gpt-6-sol"])).toBe("gpt-x");
    expect(pickOpenAiModel(undefined, ["gpt-5.5", "gpt-6-luna"])).toBe("gpt-6-luna");
    expect(pickOpenAiModel(undefined, [])).toBe("gpt-6-sol");
  });

  it("runs a tool round, then answers; the key goes only into the header", async () => {
    const KEY = "sk-test-secret-0123456789";
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ headers: new Headers(init?.headers), body });
      if (requests.length === 1) {
        return Response.json({
          id: "resp_1",
          model: "gpt-6-sol-2026-10-01",
          status: "completed",
          output: [
            { type: "function_call", call_id: "call_1", name: "list_brands", arguments: "{}" },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      }
      return Response.json({
        id: "resp_2",
        model: "gpt-6-sol-2026-10-01",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Bir marka var." }],
          },
        ],
        usage: {
          input_tokens: 150,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      });
    };
    const { api, state } = createFakeApi({ context: context("gpt"), brands: [fakeBrand()] });
    const settings = loadAgentSettings({});
    settings.vault = { openai: { apiKey: KEY, models: ["gpt-6-sol"] } };
    const out = await createChatTurnHandler({
      api,
      gate: unusedGate(),
      settings,
      logger: silentLogger,
      health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
      openaiFetch: fakeFetch,
      stateDir: mkdtempSync(path.join(tmpdir(), "openai-state-")),
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

    expect(out).toMatchObject({ provider: "openai", model: "gpt-6-sol-2026-10-01" });
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain(KEY);
    expect(requests[0]?.body.model).toBe("gpt-6-sol");
    expect(requests[1]?.body.previous_response_id).toBe("resp_1");
    expect(requests[1]?.body.input).toEqual([
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]);
    expect(state.parts.map((p) => p.type)).toEqual(["tool_step", "text"]);
    expect(state.completed[0]).toMatchObject({
      usage: expect.objectContaining({ inputTokens: 250, outputTokens: 30, thoughtsTokens: 5 }),
    });
  });

  it("turns a refused key into an auth error without echoing the key", async () => {
    const KEY = "sk-test-refused-0123456789";
    const err = await runOpenAiTurn({
      apiKey: KEY,
      model: "gpt-6-sol",
      system: "s",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      executor: {
        geminiFunctionDeclarations: () => [],
        execute: async () => ({ data: {} }),
      } as never,
      fetch: async () =>
        Response.json(
          { error: { message: `Incorrect API key provided: ${KEY}` } },
          { status: 401 },
        ),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("auth");
    expect((err as Error).message).not.toContain(KEY);
  });
});

// --- Antigravity CLI ------------------------------------------------------------------------------

describe("Antigravity CLI", () => {
  it("is signed in when `agy models` lists models", async () => {
    const runner = (models: Partial<CmdResult>): CmdRunner =>
      (async (_bin: string, args: string[]) =>
        args[0] === "--version" ? cmd({ stdout: "1.5.10\n" }) : cmd(models)) as CmdRunner;
    expect(
      await probeAntigravity(
        "agy",
        {},
        runner({
          stdout: "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
        }),
      ),
    ).toMatchObject({
      installed: true,
      version: "1.5.10",
      loggedIn: true,
      models: ["gemini-3.8-flash-high"],
    });
    expect(
      await probeAntigravity(
        "agy",
        {},
        runner({ code: 1, stderr: "Error: authentication required. Run 'agy' to log in." }),
      ),
    ).toMatchObject({ loggedIn: false, error: null });
  });

  it("streams agent_response deltas from print mode and reads the result usage", async () => {
    const bin = fakeCli(
      "agy",
      `const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (!args.includes("--sandbox") || args.includes("--dangerously-skip-permissions")) process.exit(4);
const prompt = args[args.indexOf("-p") + 1];
out({ event: "init", conversation_id: "c1", init: { cwd: process.cwd(), tools: [], permission_mode: "request-review", model: "gemini-3.8-flash-medium" } });
out({ event: "step_update", step_update: { conversation_id: "c1", step_index: 0, state: "ACTIVE", step_type: "agent_response", text_delta: "Merhaba" } });
out({ event: "step_update", step_update: { conversation_id: "c1", step_index: 0, state: "DONE", step_type: "agent_response", text_delta: prompt.includes("araçların") ? ", araçsız." : "!" } });
out({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "Merhaba, araçsız.", usage: { input_tokens: 40, output_tokens: 6, thinking_tokens: 3, cache_read_tokens: 0, total_tokens: 49 } } });
`,
    );
    const { api, state } = createFakeApi({ context: context("antigravity") });
    const out = await createChatTurnHandler({
      api,
      gate: unusedGate(),
      settings: loadAgentSettings({ STUDIO_ANTIGRAVITY_BIN: bin }),
      logger: silentLogger,
      health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
      providers: () => [ready("antigravity", false)],
      stateDir: mkdtempSync(path.join(tmpdir(), "agy-state-")),
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());
    expect(out).toMatchObject({ provider: "antigravity", model: "gemini-3.8-flash-medium" });
    expect(state.parts).toEqual([{ type: "text", text: "Merhaba, araçsız." }]);
    expect(state.completed[0]).toMatchObject({
      usage: expect.objectContaining({ inputTokens: 40, outputTokens: 6, thoughtsTokens: 3 }),
    });
  });

  it("maps a failed result to a provider error", async () => {
    const bin = fakeCli(
      "agy",
      `process.stdout.write(JSON.stringify({ event: "result", result: { status: "ERROR", error: "authentication required" } }) + "\\n"); process.exit(1);`,
    );
    const err = await runAntigravityTurn({
      bin,
      parentEnv: process.env,
      system: "s",
      prompt: "p",
      cwd: mkdtempSync(path.join(tmpdir(), "agy-cwd-")),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("auth");
  });
});

// --- routing and readiness --------------------------------------------------------------------------

describe("model routing and provider readiness", () => {
  const gemini = {
    status: "ready" as const,
    mode: "api" as const,
    apiKeyConfigured: true,
    cliVersion: null,
    defaultModel: "gemini-2.5-flash-lite",
    detail: null,
    checkedAt: NOW,
  };
  const health = { state: "ok" as const, message: "ok", checkedAt: NOW };

  it("routes codex / gpt / antigravity only when that provider is ready", () => {
    const settings = loadAgentSettings({});
    const base = { runEffort: null, settings, claudeHealth: health, geminiAccount: gemini };
    expect(() => resolveChatRoute({ ...base, runModel: "codex", providers: [] })).toThrow(
      /Codex hazır değil/,
    );
    expect(
      resolveChatRoute({ ...base, runModel: "codex", providers: [ready("codex")] }),
    ).toMatchObject({ provider: "codex" });
    expect(() => resolveChatRoute({ ...base, runModel: "gpt" })).toThrow(/OpenAI API/);
    settings.vault = { openai: { apiKey: "sk-x-0123456789", models: ["gpt-6-luna"] } };
    expect(resolveChatRoute({ ...base, runModel: "gpt" })).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
    });
    const signedOut = {
      ...ready("antigravity", false),
      state: "signed_out" as const,
      detail: "Giriş yapın.",
    };
    expect(() =>
      resolveChatRoute({ ...base, runModel: "antigravity", providers: [signedOut] }),
    ).toThrow(/Antigravity oturumu kapalı/);
  });

  it("reports Codex, OpenAI and Antigravity rows", async () => {
    const settings = loadAgentSettings({});
    const controller = new ProvidersController({
      settings,
      logger: silentLogger,
      probeCodex: async () => ({
        installed: false,
        version: null,
        loggedIn: false,
        method: null,
        error: null,
      }),
      probeAntigravity: async () => ({
        installed: true,
        version: "1.5.10",
        loggedIn: true,
        models: ["gemini-3.8-flash-high"],
        error: null,
      }),
      now: () => new Date(NOW),
    });
    const seen: AiProviderStatus[][] = [];
    controller.onChange((list) => seen.push(list));
    const list = await controller.refresh();
    expect(list.map((p) => [p.provider, p.state, p.tools])).toEqual([
      ["codex", "not_installed", true],
      ["openai", "not_configured", true],
      ["antigravity", "ready", false],
    ]);
    expect(list[0]?.detail).toContain("npm i -g --prefix ~/.local @openai/codex");
    settings.vault = { openai: { apiKey: "sk-x-0123456789", models: ["gpt-6-sol"] } };
    controller.vaultChanged();
    expect(seen.at(-1)?.[1]).toMatchObject({ state: "ready", defaultModel: "gpt-6-sol" });
    expect(JSON.stringify(seen)).not.toContain("sk-x-0123456789");
  });

  it("keeps the prices in one dated file", () => {
    const src = readFileSync(new URL("../src/gemini/pricing.ts", import.meta.url), "utf8");
    expect(src).toContain("PRICING_CHECKED_AT");
    expect(src).toContain("ai.google.dev/gemini-api/docs/pricing");
  });
});
