import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, buildClaudeEnv } from "../src/claude/args.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { classifyFailure, parseResetFromText } from "../src/claude/limits.ts";
import { runClaude } from "../src/claude/runner.ts";
import { JsonStringFieldStream, LineSplitter } from "../src/claude/stream.ts";
import { fakeClaude, REAL_STREAM, structuredLines } from "./fake-claude.ts";

const workRoot = mkdtempSync(path.join(tmpdir(), "claude-work-"));
const schema = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
};

describe("JsonStringFieldStream", () => {
  it("decodes one top-level string field across arbitrary chunk boundaries", () => {
    const value = 'Merhaba "dünya"\nİkinci satır \\ çatal / 😀 ğüşıöç \t son';
    const json = JSON.stringify({ reply: value, action: "none", nested: { reply: "nope" } });
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const stream = new JsonStringFieldStream("reply");
      let out = "";
      for (let i = 0; i < json.length; i += size) out += stream.push(json.slice(i, i + size));
      expect(out, `chunk size ${size}`).toBe(value);
      expect(stream.complete).toBe(true);
    }
  });

  it("handles \\u escapes and surrogate pairs split between chunks", () => {
    const json = '{"reply":"\\u00e7a\\ud83d\\ude00b"}';
    const stream = new JsonStringFieldStream("reply");
    let out = "";
    for (const ch of json) out += stream.push(ch);
    expect(out).toBe("ça😀b");
  });

  it("ignores the same key in nested objects and other fields", () => {
    const stream = new JsonStringFieldStream("reply");
    const out = stream.push(
      JSON.stringify({ plan: { reply: "iç", items: [{ reply: "x" }] }, other: "y", reply: "dış" }),
    );
    expect(out).toBe("dış");
  });

  it("splits stream-json output into lines", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(":2}\n\n")).toEqual(['{"b":2}']);
    expect(s.push('{"c":3}')).toEqual([]);
    expect(s.end()).toEqual(['{"c":3}']);
  });
});

describe("environment and flags", () => {
  it("passes only the allow-list (never API keys or parent session variables)", () => {
    const env = buildClaudeEnv(
      {
        HOME: "/Users/x",
        PATH: "/bin",
        USER: "x",
        LANG: "tr_TR.UTF-8",
        ANTHROPIC_API_KEY: "sk-secret",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://proxy",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "sdk",
        STUDIO_WORKER_TOKEN: "secret",
      },
      { configDir: "/Users/x/.studio/claude", oauthToken: "oauth" },
    );
    expect(env).toEqual({
      HOME: "/Users/x",
      PATH: "/bin",
      USER: "x",
      LANG: "tr_TR.UTF-8",
      CLAUDE_CONFIG_DIR: "/Users/x/.studio/claude",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
  });

  it("uses the locked-down recipe and never --bare", () => {
    const args = buildClaudeArgs({
      systemPromptFile: "/tmp/s.md",
      schema,
      model: "opus",
      partialMessages: true,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--verbose",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--include-partial-messages",
      ]),
    );
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args).not.toContain("--bare");
  });

  it("supports session persistence, --resume, and --mcp-config / --allowedTools for chat turns", async () => {
    const args = buildClaudeArgs({
      systemPromptFile: "/tmp/s.md",
      model: "sonnet",
      persistSession: true,
      resumeSessionId: "sess_42",
      mcpConfigFile: "/tmp/mcp.json",
      allowedTools: ["mcp__studio__propose_plan", "mcp__studio__ask_question"],
      partialMessages: true,
    });
    expect(args).not.toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "sess_42",
    ]);
    expect(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2)).toEqual([
      "--mcp-config",
      "/tmp/mcp.json",
    ]);
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual([
      "--allowedTools",
      "mcp__studio__propose_plan,mcp__studio__ask_question",
    ]);

    const fake = fakeClaude({
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess_init_99",
          model: "claude-sonnet-5",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sess_final_99",
          result: "Merhaba!",
          usage: { input_tokens: 4, output_tokens: 6 },
        }),
      ],
    });
    const deltas: string[] = [];
    const res = await runClaude(
      {
        label: "chat",
        system: "s",
        content: [{ type: "text", text: "selam" }],
        persistSession: true,
        onTextDelta: (t) => deltas.push(t),
      },
      { bin: fake.bin, workRoot },
    );
    expect(res.sessionId).toBe("sess_final_99");
    expect(deltas).toEqual(["Merhaba!"]);
  });
});

describe("runClaude with a fake CLI", () => {
  it("plays a recorded real call: streams the field, returns output and usage", async () => {
    const fake = fakeClaude({ fixture: REAL_STREAM, delayMs: 2 });
    const deltas: string[] = [];
    const res = await runClaude(
      {
        label: "t",
        system: "sistem",
        content: [
          { type: "text", text: "merhaba" },
          { type: "image", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
        schema,
        streamField: "reply",
        onFieldDelta: (t) => deltas.push(t),
      },
      {
        bin: fake.bin,
        workRoot,
        parentEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-must-not-leak" },
      },
    );
    const output = res.output as { reply: string; action: string; count: number };
    expect(output.action).toBe("none");
    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.join("")).toBe(output.reply);
    expect(output.reply).toContain('"Sen Studio"');
    expect(res.model).toBe("claude-opus-5-5");
    expect(res.cliVersion).toBe("2.1.292");
    expect(res.usage).toMatchObject({ inputTokens: 2, outputTokens: 184, cacheWriteTokens: 1205 });
    expect(res.usage.costUsd).toBeCloseTo(0.013328);
    expect(res.rateLimit?.status).toBe("allowed");

    const seen = fake.recorded();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.args).toContain("--include-partial-messages");
    expect(seen.args[seen.args.indexOf("--tools") + 1]).toBe("");
    const message = JSON.parse(seen.stdin);
    expect(message.type).toBe("user");
    expect(message.message.content[0]).toEqual({ type: "text", text: "merhaba" });
    expect(message.message.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    });
  });

  it("emits the field at the end when no partial messages arrive", async () => {
    const fake = fakeClaude({ lines: structuredLines({ reply: "tek parça" }) });
    const deltas: string[] = [];
    await runClaude(
      {
        label: "t",
        system: "s",
        content: [],
        schema,
        streamField: "reply",
        onFieldDelta: (t) => deltas.push(t),
      },
      { bin: fake.bin, workRoot },
    );
    expect(deltas).toEqual(["tek parça"]);
  });

  it("detects a usage limit (rejected rate-limit event) with the reset time", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const fake = fakeClaude({
      lines: [
        JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
        }),
        JSON.stringify({
          type: "assistant",
          error: "rate_limit",
          message: { content: [{ type: "text", text: "You've hit your limit · resets 7pm" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "You've hit your limit · resets 7pm",
        }),
      ],
      exitCode: 1,
    });
    const error = await runClaude(
      { label: "t", system: "s", content: [], schema },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
    const limit = error as ClaudeUsageLimitError;
    expect(limit.code).toBe("usage_limit");
    expect(limit.resetsAt.getTime()).toBe(resetsAt * 1000);
    expect(limit.resetSource).toBe("rate_limit_event");
  });

  it("detects a usage limit from the message text alone", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const fake = fakeClaude({
      lines: [
        JSON.stringify({
          type: "result",
          is_error: true,
          result: `Claude AI usage limit reached|${resetsAt}`,
        }),
      ],
      exitCode: 1,
    });
    const error = (await runClaude(
      { label: "t", system: "s", content: [], schema },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e)) as ClaudeUsageLimitError;
    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
    expect(error.resetsAt.getTime()).toBe(resetsAt * 1000);
    expect(error.resetSource).toBe("message");
  });

  it("reports auth failures", async () => {
    const fake = fakeClaude({
      lines: [
        JSON.stringify({
          type: "result",
          is_error: true,
          result: "Invalid API key · Please run /login",
        }),
      ],
      exitCode: 1,
    });
    const error = (await runClaude(
      { label: "t", system: "s", content: [], schema },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error.code).toBe("auth");
  });

  it("rejects malformed output (garbage lines, no structured output)", async () => {
    const fake = fakeClaude({
      lines: [
        "not json at all",
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"rep"}}}',
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "I cannot" }),
      ],
    });
    const error = (await runClaude(
      {
        label: "t",
        system: "s",
        content: [],
        schema,
        streamField: "reply",
        onFieldDelta: () => {},
      },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e)) as ClaudeError;
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error.code).toBe("output");
  });

  it("reports a crash without a result line", async () => {
    const fake = fakeClaude({ lines: [], stderr: "segmentation fault", exitCode: 139 });
    const error = (await runClaude(
      { label: "t", system: "s", content: [], schema },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e)) as ClaudeError;
    expect(error.code).toBe("process");
    expect(error.message).toContain("without a result");
  });

  it("reports a missing binary as a spawn error", async () => {
    const error = (await runClaude(
      { label: "t", system: "s", content: [], schema },
      { bin: path.join(workRoot, "does-not-exist"), workRoot },
    ).catch((e: unknown) => e)) as ClaudeError;
    expect(error.code).toBe("spawn");
  });

  it("times out and kills the child", async () => {
    const fake = fakeClaude({ lines: [], hang: true });
    const started = Date.now();
    const error = (await runClaude(
      { label: "t", system: "s", content: [], schema, timeoutMs: 300 },
      { bin: fake.bin, workRoot },
    ).catch((e: unknown) => e)) as ClaudeError;
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("aborts on the job's signal", async () => {
    const fake = fakeClaude({ fixture: REAL_STREAM, delayMs: 50, hang: true });
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = runClaude(
      {
        label: "t",
        system: "s",
        content: [],
        schema,
        signal: controller.signal,
        streamField: "reply",
        onFieldDelta: (t) => {
          deltas.push(t);
          controller.abort(new Error("job cancelled"));
        },
      },
      { bin: fake.bin, workRoot },
    );
    await expect(pending).rejects.toThrow("job cancelled");
    expect(deltas.length).toBeGreaterThan(0);
  });
});

describe("failure classification", () => {
  const base = {
    resultText: "",
    stderr: "",
    assistantErrors: [] as string[],
    assistantErrorTexts: [] as string[],
    rateLimit: undefined,
    now: new Date("2026-11-16T12:00:00Z"),
    fallbackResetMs: 1_800_000,
  };

  it("parses reset times from messages", () => {
    const now = new Date(2026, 10, 16, 15, 30);
    expect(parseResetFromText("limit reached|1794845400", now)?.getTime()).toBe(1794845400 * 1000);
    expect(parseResetFromText("5-hour limit reached ∙ resets 7pm", now)?.getHours()).toBe(19);
    const tomorrow = parseResetFromText("resets at 09:15", now);
    expect([tomorrow?.getDate(), tomorrow?.getHours(), tomorrow?.getMinutes()]).toEqual([
      17, 9, 15,
    ]);
    expect(parseResetFromText("no time here", now)).toBeNull();
  });

  it("separates usage limit, auth, transient and other errors", () => {
    expect(classifyFailure({ ...base, resultText: "API Error: 529 overloaded_error" }).code).toBe(
      "transient",
    );
    expect(classifyFailure({ ...base, resultText: "OAuth token has expired" }).code).toBe("auth");
    const limited = classifyFailure({ ...base, resultText: "Claude usage limit reached" });
    expect(limited.code).toBe("usage_limit");
    expect(limited.resetSource).toBe("fallback");
    expect(limited.resetsAt?.getTime()).toBe(base.now.getTime() + 1_800_000);
    expect(
      classifyFailure({ ...base, rateLimit: { status: "allowed_warning" }, resultText: "boom" })
        .code,
    ).toBe("process");
  });
});
