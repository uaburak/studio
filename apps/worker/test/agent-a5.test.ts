import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Content, Message, TurnContext } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  findSkillsDir,
  invokedSkill,
  loadSkills,
  parseSkill,
  skillsNote,
} from "../src/chat/skills.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { conversationWorkDir, sessionToResume } from "../src/chat/turn.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { buildAgentArgs } from "../src/claude/args.ts";
import {
  newStreamParseState,
  parseRecordedStream,
  parseStreamLine,
  shortToolName,
} from "../src/claude/events.ts";
import { runClaude, stopChild } from "../src/claude/runner.ts";
import { UsageTracker } from "../src/claude/usage.ts";
import {
  mergeUsage,
  parseResetText,
  parseUsageCommandOutput,
  UsagePoller,
  windowOfLabel,
} from "../src/claude/usage-cli.ts";
import { createFakeApi, fakeRun, NOW } from "./fake-api.ts";
import { fakeClaude } from "./fake-claude.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// --- stream-json parser ----------------------------------------------------------------------

describe("stream-json parser (Wecra-style)", () => {
  it("streams text once, turns tool_use / tool_result into steps, reads session, limits and result", () => {
    const lines = [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "claude-opus-5-5",
        claude_code_version: "2.1.292",
        mcp_servers: [{ name: "studio", status: "connected" }],
      },
      { type: "stream_event", event: { type: "message_start" } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bakı" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "yorum." } },
      },
      // The whole text block again: already streamed, not repeated.
      { type: "assistant", message: { content: [{ type: "text", text: "Bakıyorum." }] } },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "toolu_1", name: "mcp__studio__view_alias" },
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__studio__view_alias",
              input: { alias: "image" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: '{"ok":true,"alias":"image"}\nmore' }],
            },
          ],
        },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4 } } },
      },
      { type: "stream_event", event: { type: "message_start" } },
      // Without partial deltas the assistant message carries the text.
      { type: "assistant", message: { content: [{ type: "text", text: "Hazır." }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hazır.",
        session_id: "sess-1",
        usage: { input_tokens: 3 },
      },
    ];
    const events = parseRecordedStream(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(events).toEqual([
      { type: "session", id: "sess-1", model: "claude-opus-5-5", cliVersion: "2.1.292" },
      { type: "text", delta: "Bakı" },
      { type: "text", delta: "yorum." },
      { type: "tool", id: "toolu_1", name: "view_alias", state: "running" },
      {
        type: "tool",
        id: "toolu_1",
        name: "view_alias",
        state: "running",
        args: { alias: "image" },
      },
      {
        type: "tool",
        id: "toolu_1",
        name: "view_alias",
        state: "done",
        summary: '{"ok":true,"alias":"image"}',
      },
      {
        type: "limits",
        info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4 } } },
      },
      { type: "text", delta: "Hazır." },
      {
        type: "result",
        isError: false,
        text: "Hazır.",
        sessionId: "sess-1",
        subtype: "success",
        usage: { input_tokens: 3 },
      },
    ]);
  });

  it("flags a disconnected MCP server, tool errors and the CLI's sign-in notice", () => {
    const state = newStreamParseState();
    expect(
      parseStreamLine(
        {
          type: "system",
          subtype: "init",
          session_id: "s",
          mcp_servers: [{ name: "studio", status: "failed" }],
        },
        state,
      ),
    ).toEqual([{ type: "session", id: "s", mcpProblem: "failed" }]);
    expect(
      parseStreamLine(
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        },
        state,
      ),
    ).toEqual([]);
    parseStreamLine(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "mcp__studio__propose_plan" }] },
      },
      state,
    );
    expect(
      parseStreamLine(
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t2", is_error: true, content: "Hata: x" },
            ],
          },
        },
        state,
      ),
    ).toEqual([
      { type: "tool", id: "t2", name: "propose_plan", state: "error", summary: "Hata: x" },
    ]);
    expect(shortToolName("mcp__studio__get_skill")).toBe("get_skill");
  });

  it("parses a recorded real turn (this Mac, CLI 2.1.292): session, text, MCP tool steps, result", () => {
    // Recorded by scripts/e2e-agent.ts (turn 1: view a photo, plan, schedule after consent).
    const events = parseRecordedStream(
      readFileSync(fixture("real-agent-turn.stream.jsonl"), "utf8"),
    );
    const order: string[] = [];
    for (const e of events) if (e.type === "tool" && !order.includes(e.name)) order.push(e.name);
    expect(order).toEqual(["list_aliases", "view_alias", "propose_plan", "schedule_content"]);
    for (const name of order) {
      const states = events.flatMap((e) => (e.type === "tool" && e.name === name ? [e.state] : []));
      expect([name, states[0], states.at(-1)]).toEqual([name, "running", "done"]);
    }
    expect(events[0]).toMatchObject({
      type: "session",
      id: "f2c6183b-2c5c-46e1-8c97-9370e73d1ee3",
    });
    const session = events.find((e) => e.type === "session");
    expect(session).toMatchObject({ type: "session" });
    expect(session && "mcpProblem" in session ? session.mcpProblem : undefined).toBeUndefined();
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.type === "tool" && t.name).not.toMatch(/^mcp__/);
    const finished = tools.filter((t) => t.type === "tool" && t.state !== "running");
    expect(finished.length).toBeGreaterThan(0);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e.type === "text" ? e.delta : ""))
      .join("");
    expect(text.length).toBeGreaterThan(0);
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", isError: false });
    // No text is counted twice: the streamed text equals the final message(s).
    expect(text).toContain(result?.type === "result" ? result.text.slice(0, 40) : "");
  });
});

// --- flags -------------------------------------------------------------------------------------

describe("agent flags", () => {
  it("new session vs resume, MCP only, append system prompt", () => {
    const fresh = buildAgentArgs({
      mcpConfigFile: "/w/mcp.json",
      appendSystemPrompt: "Rehber",
      model: "opus",
      effort: "medium",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(fresh).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config",
      "/w/mcp.json",
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__studio",
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      "Rehber",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--model",
      "opus",
      "--effort",
      "medium",
      "--session-id",
      "11111111-2222-4333-8444-555555555555",
    ]);
    const resumed = buildAgentArgs({
      mcpConfigFile: "/w/mcp.json",
      appendSystemPrompt: "Rehber",
      resumeSessionId: "sess-9",
      sessionId: "ignored",
    });
    expect(resumed.slice(-2)).toEqual(["--resume", "sess-9"]);
    expect(resumed).not.toContain("--session-id");
    expect(resumed).not.toContain("--no-session-persistence");
  });
});

// --- session staleness -----------------------------------------------------------------------

function msg(id: string, role: Message["role"]): Message {
  return {
    id,
    conversationId: "conv_1",
    role,
    status: "complete",
    runId: role === "assistant" ? "run_0" : null,
    parts: [{ type: "text", text: id }],
    mentions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ctx(
  overrides: Partial<TurnContext> & { session?: TurnContext["conversation"]["agentSession"] },
) {
  const { session, ...rest } = overrides;
  const messages = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user")];
  return {
    run: fakeRun({ triggerMessageId: "m3" }),
    conversation: {
      id: "conv_1",
      brandId: "brand_1",
      title: "",
      status: "active",
      activeRunId: "run_1",
      lastSeq: 1,
      agentSession:
        session === undefined
          ? { id: "sess-0", messageCount: 2, runId: "run_0", updatedAt: NOW }
          : session,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    brand: null,
    brandProfile: null,
    messages,
    messagesTruncated: false,
    assets: [],
    openPlan: null,
    assistantMessage: null,
    aliases: [],
    messageCount: 3,
    ...rest,
  } as TurnContext;
}

describe("session staleness (sessionToResume)", () => {
  it("resumes while nothing else was said since the session's turn", () => {
    expect(sessionToResume(ctx({}))).toBe("sess-0");
  });

  it("starts over when another run answered, a message is missing, or there is no session", () => {
    // Another run answered meanwhile (one more message than the session saw + the trigger).
    expect(sessionToResume(ctx({ messageCount: 4 }))).toBeUndefined();
    // Count mismatch the other way (messages deleted / unknown).
    expect(sessionToResume(ctx({ messageCount: 2 }))).toBeUndefined();
    expect(sessionToResume(ctx({ session: null }))).toBeUndefined();
    // A retried attempt never resumes (the lost attempt may have written into the session).
    expect(
      sessionToResume(ctx({ run: fakeRun({ triggerMessageId: "m3", attempt: 2 }) })),
    ).toBeUndefined();
    // This run already wrote (a previous attempt).
    expect(sessionToResume(ctx({ assistantMessage: msg("m4", "assistant") }))).toBeUndefined();
    // No count from the server and older messages left out: unknown.
    expect(
      sessionToResume(ctx({ messageCount: undefined, messagesTruncated: true })),
    ).toBeUndefined();
  });

  it("an answered question of the session's own turn continues it (no new message)", () => {
    const c = ctx({ run: fakeRun({ triggerMessageId: "m2" }), messageCount: 2 });
    c.messages = c.messages.slice(0, 2);
    expect(sessionToResume(c)).toBe("sess-0");
  });

  it("keeps one work folder per conversation", () => {
    expect(conversationWorkDir("/state", "conv_1")).toBe(path.join("/state", "chat", "conv_1"));
    expect(conversationWorkDir("/state", "../x")).toBe(path.join("/state", "chat", "___x"));
  });
});

// --- /usage --------------------------------------------------------------------------------------

describe("claude -p /usage (no model call)", () => {
  it("parses the recorded output of this Mac's CLI", () => {
    const now = new Date("2026-11-16T13:37:00Z"); // 16:37 in Istanbul
    const raw = JSON.parse(readFileSync(fixture("real-usage-command.json"), "utf8"));
    expect([raw.num_turns, raw.total_cost_usd, raw.duration_api_ms, raw.local_command]).toEqual([
      0,
      0,
      0,
      "usage",
    ]);
    const report = parseUsageCommandOutput(JSON.stringify(raw), now);
    expect(report).toEqual({
      source: "claude -p /usage",
      observedAt: now.toISOString(),
      windows: [
        {
          kind: "five_hour",
          name: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-11-16T16:10:00.000Z",
          limited: true,
        },
        {
          kind: "weekly",
          name: "seven_day",
          usedPercent: 49,
          resetsAt: "2026-11-18T11:00:00.000Z",
          limited: false,
        },
        {
          kind: "other",
          name: "seven_day_fable",
          usedPercent: 32,
          resetsAt: "2026-11-18T11:00:00.000Z",
          limited: false,
        },
      ],
    });
  });

  it("reads reset texts and labels, and ignores what is not a /usage answer", () => {
    const now = new Date("2026-12-31T20:00:00Z");
    expect(parseResetText("Jan 2 at 9am (Europe/Istanbul)", now)?.toISOString()).toBe(
      "2027-01-02T06:00:00.000Z",
    );
    expect(parseResetText("11:30pm (Europe/Istanbul)", now)?.toISOString()).toBe(
      "2026-12-31T20:30:00.000Z",
    );
    expect(parseResetText("soon", now)).toBeNull();
    expect(windowOfLabel("Current week (Sonnet only)")).toEqual({
      kind: "other",
      name: "seven_day_sonnet_only",
    });
    expect(parseUsageCommandOutput("not json", now)).toBeNull();
    expect(
      parseUsageCommandOutput(JSON.stringify({ local_command: "cost", result: "x" }), now),
    ).toBeNull();
    expect(
      parseUsageCommandOutput(
        JSON.stringify({ local_command: "usage", is_error: true, result: "Not logged in" }),
        now,
      ),
    ).toBeNull();
  });

  it("merges with live rate_limit_event windows and reads at most once a minute", async () => {
    const live = {
      source: "rate_limit_event",
      observedAt: "2026-11-16T14:00:00.000Z",
      windows: [
        { kind: "five_hour" as const, name: "five_hour", usedPercent: 12, limited: false },
        { kind: "weekly" as const, name: "seven_day", usedPercent: 50, limited: false },
      ],
    };
    const cli = {
      source: "claude -p /usage",
      observedAt: "2026-11-16T13:00:00.000Z",
      windows: [
        { kind: "other" as const, name: "seven_day_fable", usedPercent: 32, limited: false },
        { kind: "five_hour" as const, name: "five_hour", usedPercent: 100, limited: true },
      ],
    };
    const merged = mergeUsage(cli, live);
    expect(merged.windows.map((w) => [w.name, w.usedPercent])).toEqual([
      ["five_hour", 12],
      ["seven_day", 50],
      ["seven_day_fable", 32],
    ]);
    const tracker = new UsageTracker(null);
    let reads = 0;
    let clock = 0;
    const poller = new UsagePoller({
      tracker,
      read: async () => {
        reads++;
        return cli;
      },
      now: () => clock,
    });
    await poller.refresh();
    clock = 30_000;
    await poller.refresh();
    expect(reads).toBe(1);
    clock = 61_000;
    await poller.refresh();
    expect(reads).toBe(2);
    tracker.merge(live);
    expect(tracker.latest()?.windows.map((w) => w.name)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
  });
});

// --- stop escalation ---------------------------------------------------------------------------

describe("stopping a run", () => {
  it("SIGINT first, SIGKILL when the CLI ignores it", async () => {
    const stubborn = spawn(process.execPath, [
      "-e",
      "process.on('SIGINT',()=>{}); setInterval(()=>{},1000); console.log('up')",
    ]);
    await new Promise((r) => stubborn.stdout.once("data", r));
    const t0 = Date.now();
    stopChild(stubborn, 150);
    const signal = await new Promise((r) => stubborn.on("close", (_c, s) => r(s)));
    expect(signal).toBe("SIGKILL");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    const polite = spawn(process.execPath, ["-e", "setInterval(()=>{},1000); console.log('up')"]);
    await new Promise((r) => polite.stdout.once("data", r));
    stopChild(polite, 5_000);
    expect(await new Promise((r) => polite.on("close", (_c, s) => r(s)))).toBe("SIGINT");
  });

  it("cancelling an agent call sends SIGINT to the CLI", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stop-"));
    const sigintFile = path.join(dir, "sigint");
    const fake = fakeClaude({
      lines: [JSON.stringify({ type: "system", subtype: "init", session_id: "s" })],
      hang: true,
      sigintFile,
    });
    const controller = new AbortController();
    const call = runClaude(
      {
        label: "stop",
        system: "x",
        content: [{ type: "text", text: "hi" }],
        signal: controller.signal,
        agent: { cwd: path.join(dir, "cwd"), mcpConfigFile: path.join(dir, "mcp.json") },
      },
      { bin: fake.bin, parentEnv: { HOME: dir, PATH: "/usr/bin:/bin" } },
    );
    // Wait until the fake runs (it records argv after reading stdin).
    for (let i = 0; i < 100 && !existsSync(path.join(fake.dir, "record.json")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    controller.abort(new Error("run cancelled"));
    await expect(call).rejects.toThrow("run cancelled");
    for (let i = 0; i < 50 && !existsSync(sigintFile); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(sigintFile, "utf8")).toBe("SIGINT");
    // Agent calls run in the conversation's folder with MCP_TOOL_TIMEOUT-capable env.
    expect(realpathSync(fake.recorded().cwd)).toBe(realpathSync(path.join(dir, "cwd")));
    expect(fake.recorded().args).toContain("--append-system-prompt");
  });
});

// --- skills --------------------------------------------------------------------------------------

describe("runtime skills", () => {
  it("loads the repo's agent/skills and lists name + description only", async () => {
    const dir = findSkillsDir();
    expect(dir).toMatch(/agent[/\\]skills$/);
    const skills = await loadSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(["aylik-plan", "carousel", "urun-postu"]);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.text).not.toMatch(/^---/);
    }
    const note = skillsNote(skills);
    expect(note).toContain("- aylik-plan: ");
    expect(note).not.toContain(skills[0]?.text.slice(0, 40) ?? "-");
  });

  it("`/name` at the start of a message inlines that skill for the turn", () => {
    const skills = [
      parseSkill(
        "---\nname: carousel\ndescription: Kaydırmalı post\n---\n# Carousel\nAdımlar…",
        "x",
      ),
      parseSkill("# Ürün\nÜrün postu yapar.", "urun-postu"),
    ].flatMap((s) => (s ? [s] : []));
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["carousel", "Kaydırmalı post"],
      ["urun-postu", "# Ürün"],
    ]);
    const hit = invokedSkill("/carousel 5 slayt, gübre ipuçları", skills);
    expect(hit?.skill.name).toBe("carousel");
    expect(hit?.rest).toBe("5 slayt, gübre ipuçları");
    expect(invokedSkill("/yok merhaba", skills)).toBeNull();
    expect(invokedSkill("bir /carousel yap", skills)).toBeNull();
    const note = skillsNote(skills, hit?.skill);
    expect(note).toContain('<calistirilan_beceri ad="carousel">');
    expect(note).toContain("Adımlar…");
    expect(note).toContain("- urun-postu: ");
  });
});

// --- new tools ---------------------------------------------------------------------------------

describe("generation tools", () => {
  function content(overrides: Partial<Content> = {}): Content {
    return {
      id: "cnt_1",
      brandId: "brand_1",
      type: "carousel",
      title: "Bahar",
      brief: "Tarla hazırlığı",
      status: "in_review",
      targetPlatforms: ["instagram"],
      caption: "",
      currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function executor() {
    const { api, state } = createFakeApi();
    const signal = new AbortController().signal;
    const writer = new TurnWriter({ api, runId: "run_1", attempt: 1, signal, flushIntervalMs: 5 });
    const ex = new StudioToolExecutor({
      api,
      writer,
      runId: "run_1",
      conversationId: "conv_1",
      initialBrandId: "brand_1",
      initialOpenPlan: null,
      aliases: [],
      signal,
      jobPollIntervalMs: 10,
      generationChoice: { model: "sonnet", effort: "high" },
      skills: [{ name: "carousel", description: "Kaydırmalı post", text: "Adımlar" }],
    });
    return { api, state, ex, writer };
  }

  it("generate_post queues content.generate (no inline design); wait_jobs reports; revise_post starts from the current version", async () => {
    const { state, ex, writer } = executor();
    const gen = await ex.execute("generate_post", {
      brief: "Gübreleme takvimi, 4 slayt",
      type: "carousel",
      title: "Gübre takvimi",
    });
    expect(gen.isError).toBe(false);
    const job = state.jobs[0];
    expect(job).toMatchObject({ type: "content.generate", brandId: "brand_1", status: "queued" });
    expect(job?.payload).toMatchObject({
      title: "Gübre takvimi",
      type: "carousel",
      targetPlatforms: ["instagram"],
      conversationId: "conv_1",
      model: "sonnet",
      effort: "high",
    });
    expect(gen.data).toMatchObject({ ok: true, jobIds: [job?.id] });

    setTimeout(() => {
      if (job) job.status = "succeeded";
    }, 30);
    const waited = await ex.execute("wait_jobs", { jobIds: [job?.id], timeoutSec: 5 });
    expect(waited.data).toMatchObject({
      finished: true,
      jobs: [{ id: job?.id, status: "succeeded" }],
    });

    state.contents.set("cnt_1", content());
    const revised = await ex.execute("revise_post", {
      contentId: "cnt_1",
      instruction: "Başlığı kısalt",
    });
    expect(revised.isError).toBe(false);
    expect(state.jobs[1]?.payload).toMatchObject({
      baseVersion: 1,
      instructions: "Başlığı kısalt",
      type: "carousel",
    });
    await writer.flush();
    expect(state.parts.filter((p) => p.type === "tool_step").map((p) => [p.name, p.state])).toEqual(
      [
        ["generate_post", "done"],
        ["wait_jobs", "done"],
        ["revise_post", "done"],
      ],
    );
    expect(state.parts.some((p) => p.type === "content_ref")).toBe(true);
  });

  it("view_post returns the rendered slides as pictures; get_skill returns the text", async () => {
    const { state, ex } = executor();
    const jpg = new Uint8Array(
      await sharp({ create: { width: 108, height: 135, channels: 3, background: "#aa3355" } })
        .jpeg()
        .toBuffer(),
    );
    state.assets.set("asset_slide_1", { bytes: jpg, contentType: "image/jpeg" });
    state.contents.set("cnt_1", content());
    state.versions.push({
      id: "ver_1",
      contentId: "cnt_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 2,
      note: null,
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [
        { html: "<p>1</p>", width: 1080, height: 1350, renderedAssetId: "asset_slide_1" },
        { html: "<p>2</p>", width: 1080, height: 1350, renderedAssetId: null },
      ],
    });
    const post = await ex.execute("view_post", { contentId: "cnt_1" });
    expect(post.images).toHaveLength(1);
    expect(post.data).toMatchObject({ shownSlides: 1, notRendered: [2], version: 1 });
    const skill = await ex.execute("get_skill", { name: "/carousel" });
    expect(skill.data).toMatchObject({ name: "carousel", instructions: "Adımlar" });
    const missing = await ex.execute("get_skill", { name: "yok" });
    expect(missing.isError).toBe(true);
  });
});
