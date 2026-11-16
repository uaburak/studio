import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Job,
  type Message,
  PlanProposalPut,
  type TurnAlias,
  type TurnContext,
} from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { selectTurnImages } from "../src/chat/images.ts";
import { buildChatContext, todayLine } from "../src/chat/prompt.ts";
import {
  CHAT_TURN_JSON_SCHEMA,
  ChatTurnOutput,
  convertPlan,
  toQuestionPart,
} from "../src/chat/schema.ts";
import { createChatTurnHandler } from "../src/chat/turn.ts";
import { splitUtf8 } from "../src/chat/writer.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, fakeRun, NOW } from "./fake-api.ts";

const TEXT =
  "MTM için kasım ayının postlarını planla, ürün postunda @image kullan, diğer görselleri ben yükleyeceğim";

function alias(overrides: Partial<TurnAlias> = {}): TurnAlias {
  return {
    id: "alias_1",
    conversationId: "conv_1",
    alias: "image",
    previousAliases: [],
    assetId: "asset_photo",
    kind: "image",
    mimeType: "image/png",
    width: 1200,
    height: 1200,
    filename: "venta-borinc.png",
    contentPath: "/api/assets/asset_photo/content",
    messageId: "msg_1",
    createdAt: NOW,
    updatedAt: NOW,
    objectKey: "brands/brand_1/assets/asset_photo.png",
    ...overrides,
  };
}

function userMessage(overrides: Partial<Message> = {}): Message {
  const at = TEXT.indexOf("@image");
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "user",
    status: "complete",
    runId: null,
    parts: [
      { type: "text", text: TEXT },
      {
        type: "attachment",
        assetId: "asset_photo",
        kind: "image",
        mimeType: "image/png",
        width: 1200,
        height: 1200,
        filename: "venta-borinc.png",
        alias: "image",
        aliasId: "alias_1",
      },
    ],
    mentions: [
      { alias: "image", aliasId: "alias_1", assetId: "asset_photo", start: at, end: at + 6 },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    run: fakeRun(),
    conversation: {
      id: "conv_1",
      brandId: "brand_1",
      title: "Kasım",
      status: "active",
      activeRunId: "run_1",
      lastSeq: 3,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    brand: fakeBrand(),
    brandProfile: {
      id: "prof_1",
      brandId: "brand_1",
      version: 1,
      status: "approved",
      isCurrent: true,
      tokens: {
        status: "provisional",
        facts: { allowedNumbers: ["3"], product: { full_name: "Venta Borinc" } },
      },
      designRules: "Yeşil bantlar.",
      voice: "Sade, güven veren.",
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
    },
    messages: [userMessage()],
    messagesTruncated: false,
    assets: [],
    openPlan: null,
    assistantMessage: null,
    aliases: [alias()],
    ...overrides,
  };
}

const planOutput = {
  reply:
    "Kasım için 4 postluk bir plan hazırladım. Ürün postunda @image kullanacağım; diğer görselleri sen yükleyeceksin. Profil geçici.",
  action: "plan",
  plan: {
    title: "MTM Agro — Kasım 2026",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    summary: "Ürün, uygulama ve marka postları.",
    items: [
      {
        date: "2026-11-18",
        platforms: ["instagram"],
        contentType: "post",
        title: "Venta Borinc tanıtım",
        brief: "Ürünü ambalajıyla tanıt.",
        pillar: "ürün tanıtımı",
        imageSlot: "user_upload",
        imageBrief: "Ürün ambalajı fotoğrafı",
        imageAliases: ["image"],
      },
      {
        date: "2026-11-21",
        platforms: ["instagram", "instagram"],
        contentType: "carousel",
        title: "Depolama ipuçları",
        brief: "Etiketteki depolama kuralları.",
        pillar: "uygulama ipuçları",
        imageSlot: "none",
        imageBrief: "",
        imageAliases: [],
      },
      {
        date: "2026-12-02",
        platforms: ["instagram"],
        contentType: "post",
        title: "Tarlada Venta",
        brief: "Saha fotoğrafıyla marka postu.",
        pillar: "marka hikâyesi",
        imageSlot: "user_upload",
        imageBrief: "Tarlada çalışan çiftçi",
        imageAliases: ["image-9"],
      },
    ],
  },
};

function result(output: unknown, overrides: Partial<ClaudeCallResult> = {}): ClaudeCallResult {
  return {
    output,
    text: JSON.stringify(output),
    model: "claude-opus-5-5",
    cliVersion: "2.1.292",
    usage: {
      inputTokens: 12,
      outputTokens: 900,
      cacheReadTokens: 0,
      cacheWriteTokens: 9000,
      costUsd: 0.25,
      durationMs: 9000,
      durationApiMs: 8500,
      wallMs: 9600,
    },
    rateLimit: undefined,
    ...overrides,
  };
}

/** A runner that streams `reply` in a few pieces like the CLI does. */
function streamingRunner(
  output: Record<string, unknown>,
  seen: ClaudeCallOptions[] = [],
): ClaudeRunner {
  return async (options) => {
    seen.push(options);
    const reply = String(output.reply ?? "");
    for (let i = 0; i < reply.length; i += 17) {
      options.onFieldDelta?.(reply.slice(i, i + 17));
      await new Promise((r) => setTimeout(r, 1));
    }
    return result(output);
  };
}

async function png(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 40, height: 30, channels: 3, background: "#66b052" } })
      .png()
      .toBuffer(),
  );
}

function deps(api: AgentDeps["api"], runner: ClaudeRunner, gateOptions = {}): AgentDeps {
  return {
    api,
    gate: new ClaudeGate({ runner, ...gateOptions }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-state-")),
    now: () => new Date("2026-11-16T09:00:00Z"),
  };
}

function jobContext(signal = new AbortController().signal) {
  const progress: [number, string | undefined][] = [];
  const job: Job = {
    id: "job_1",
    type: "chat.turn",
    status: "running",
    payload: { conversationId: "conv_1", runId: "run_1" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const ctx: JobContext = {
    jobId: "job_1",
    job,
    attempt: 1,
    workerId: "mac",
    signal,
    progress: (v, m) => progress.push([v, m]),
    log: () => {},
  };
  return { ctx, progress };
}

describe("chat output schema and plan conversion", () => {
  it("validates the model output and converts the plan for PUT plan", () => {
    const out = ChatTurnOutput.parse(planOutput);
    const { plan, notes } = convertPlan(out.plan as NonNullable<typeof out.plan>, {
      aliases: [alias()],
    });
    expect(PlanProposalPut.safeParse(plan).success).toBe(true);
    expect(plan.items[0]).toMatchObject({
      imageSlot: "user_upload",
      imageBrief: "@image — Ürün ambalajı fotoğrafı",
      pillar: "ürün tanıtımı",
    });
    expect(plan.items[1]).toMatchObject({
      platforms: ["instagram"],
      imageBrief: null,
      imageSlot: "none",
    });
    expect(plan.items[2]).toMatchObject({ date: null, imageBrief: "Tarlada çalışan çiftçi" });
    expect(notes).toEqual([
      "item 3: date 2026-12-02 outside the period, cleared",
      "item 3: unknown alias @image-9 dropped",
    ]);
  });

  it("resolves previous alias names to the current one and keeps written mentions", () => {
    const out = ChatTurnOutput.parse({
      ...planOutput,
      plan: {
        ...planOutput.plan,
        items: [
          { ...planOutput.plan.items[0], imageAliases: ["urun"], imageBrief: "@kapak ön planda" },
        ],
      },
    });
    const { plan } = convertPlan(out.plan as NonNullable<typeof out.plan>, {
      aliases: [alias({ alias: "kapak", previousAliases: ["urun"] })],
    });
    expect(plan.items[0]?.imageBrief).toBe("@kapak ön planda");
    // A mention inside punctuation (as the model wrote it in the e2e run) is not added twice.
    const again = convertPlan(
      {
        ...planOutput.plan,
        items: [
          {
            ...planOutput.plan.items[0],
            imageAliases: ["image"],
            imageBrief: "Ambalaj (@image), beyaz zemin.",
          },
        ],
      } as NonNullable<typeof out.plan>,
      { aliases: [alias()] },
    );
    expect(again.plan.items[0]?.imageBrief).toBe("Ambalaj (@image), beyaz zemin.");
  });

  it("turns a question into a valid question part", () => {
    expect(
      toQuestionPart(
        {
          prompt: "Hangi marka?",
          mode: "single",
          options: [
            { id: "MTM Agro", label: "MTM Agro" },
            { id: "MTM Agro", label: "Venta" },
          ],
          allowText: true,
        },
        "q1",
      ),
    ).toEqual({
      type: "question",
      questionId: "q1",
      prompt: "Hangi marka?",
      mode: "single",
      options: [
        { id: "mtm-agro", label: "MTM Agro", description: null },
        { id: "mtm-agro-2", label: "Venta", description: null },
      ],
      allowText: true,
    });
    expect(
      toQuestionPart({ prompt: "Ne?", mode: "single", options: [], allowText: true }, "q"),
    ).toMatchObject({
      mode: "text",
      options: [],
      allowText: false,
    });
  });

  it("keeps `reply` first in the JSON schema so it streams before the plan", () => {
    expect(Object.keys(CHAT_TURN_JSON_SCHEMA.properties)[0]).toBe("reply");
  });
});

describe("image selection", () => {
  it("takes mentioned and attached images of the latest user message only", () => {
    const older = userMessage({
      id: "msg_0",
      mentions: [],
      parts: [
        {
          type: "attachment",
          assetId: "asset_old",
          kind: "image",
          mimeType: "image/jpeg",
          width: 10,
          height: 10,
          filename: null,
          alias: "image-1",
          aliasId: "alias_old",
        },
      ],
    });
    const latest = userMessage({
      id: "msg_1",
      parts: [
        { type: "text", text: "@image-1 ve ekteki logo" },
        {
          type: "attachment",
          assetId: "asset_svg",
          kind: "logo",
          mimeType: "image/svg+xml",
          width: null,
          height: null,
          filename: "logo.svg",
          alias: "file",
          aliasId: "alias_svg",
        },
        {
          type: "attachment",
          assetId: "asset_new",
          kind: "image",
          mimeType: "image/webp",
          width: 20,
          height: 20,
          filename: "new.webp",
          alias: "image-2",
          aliasId: "alias_new",
        },
      ],
      mentions: [
        { alias: "image-1", aliasId: "alias_old", assetId: "asset_old", start: 0, end: 8 },
      ],
    });
    const context = turnContext({
      messages: [older, latest],
      aliases: [
        alias({ id: "alias_old", alias: "image-1", assetId: "asset_old", mimeType: "image/jpeg" }),
        alias({ id: "alias_svg", alias: "file", assetId: "asset_svg", mimeType: "image/svg+xml" }),
        alias({ id: "alias_new", alias: "image-2", assetId: "asset_new", mimeType: "image/webp" }),
      ],
    });
    const selected = selectTurnImages(context, 4);
    expect(selected.map((s) => [s.alias, s.reason])).toEqual([
      ["image-1", "mentioned"],
      ["image-2", "attached"],
    ]);
    expect(selectTurnImages(context, 1).map((s) => s.alias)).toEqual(["image-1"]);
  });

  it("uses the latest user message when an answered question triggered the run", () => {
    const assistant: Message = {
      ...userMessage({ id: "msg_2", role: "assistant", mentions: [] }),
      parts: [],
    };
    const context = turnContext({
      run: fakeRun({ triggerMessageId: "msg_2" }),
      messages: [userMessage(), assistant],
    });
    expect(selectTurnImages(context, 4).map((s) => s.assetId)).toEqual(["asset_photo"]);
  });
});

describe("prompt context", () => {
  it("states today's date, the brand, the provisional profile, aliases and the transcript", () => {
    const text = buildChatContext({
      context: turnContext(),
      now: new Date("2026-11-16T09:00:00Z"),
      brands: [],
      images: [
        {
          alias: "image",
          mimeType: "image/png",
          width: 1200,
          height: 1200,
          filename: "venta-borinc.png",
          attached: true,
        },
      ],
    });
    expect(todayLine(new Date("2026-11-16T22:30:00Z"))).toBe(
      "2026-11-17 (Salı), saat dilimi Europe/Istanbul",
    );
    expect(text).toContain("<bugun>2026-11-16 (Pazartesi)");
    expect(text).toContain("ad: MTM Agro");
    expect(text).toContain('durum="geçici (provisional)"');
    expect(text).toContain(
      "- @image: image, image/png, 1200x1200, venta-borinc.png — son mesajda; görüntüsü ekte",
    );
    expect(text).toContain(TEXT);
    expect(text).toContain("[ek: @image (image/png, venta-borinc.png)]");
  });
});

describe("chat.turn handler", () => {
  it("streams the reply, proposes the plan and completes the run", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    state.assets.set("asset_photo", { bytes: await png(), contentType: "image/png" });
    const seen: ClaudeCallOptions[] = [];
    const handler = createChatTurnHandler(deps(api, streamingRunner(planOutput, seen)));
    const { ctx, progress } = jobContext();

    const out = await handler.run({ conversationId: "conv_1", runId: "run_1" }, ctx);

    expect(out).toMatchObject({
      action: "plan",
      planId: "plan_1",
      planItems: 3,
      images: ["image"],
    });
    // Reply streamed as text deltas of part 0, seq 1..n, nothing else in between.
    const deltas = state.opsCalls.flat().filter((op) => op.op === "text.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => (d.op === "text.delta" ? d.seq : 0))).toEqual(
      deltas.map((_, i) => i + 1),
    );
    expect(state.parts[0]).toEqual({ type: "text", text: planOutput.reply });
    expect(state.parts[1]).toEqual({ type: "plan_proposal", planId: "plan_1" });
    expect(state.plans[0]?.items[0]?.imageBrief).toBe("@image — Ürün ambalajı fotoğrafı");
    expect(state.plans[0]).not.toHaveProperty("brandId");
    expect(state.completed).toEqual([
      {
        attempt: 1,
        model: "claude-opus-5-5",
        usage: expect.objectContaining({
          model: "claude-opus-5-5",
          requestedModel: "opus",
          effort: "medium",
          inputTokens: 12,
          outputTokens: 900,
          costUsd: 0.25,
          calls: 1,
        }),
      },
    ]);
    // Defaults when the run names nothing: opus / medium.
    expect([seen[0]?.model, seen[0]?.effort]).toEqual(["opus", "medium"]);
    expect(state.failed).toEqual([]);
    // The model saw the context, the label and the image itself.
    const content = seen[0]?.content ?? [];
    expect(content[0]?.type === "text" && content[0].text).toContain("<takma_adlar>");
    expect(content.some((b) => b.type === "image")).toBe(true);
    expect(content.some((b) => b.type === "text" && b.text.startsWith("Görsel @image"))).toBe(true);
    expect(seen[0]?.streamField).toBe("reply");
    expect(progress.at(-1)).toEqual([1, "Tamamlandı"]);
  });

  it("uses the model and effort picked for the run", async () => {
    const run = { ...fakeRun(), model: "sonnet", effort: "high" as const };
    const { api, state } = createFakeApi({ context: turnContext({ run }) });
    state.assets.set("asset_photo", { bytes: await png(), contentType: "image/png" });
    const seen: ClaudeCallOptions[] = [];
    const out = await createChatTurnHandler(deps(api, streamingRunner(planOutput, seen))).run(
      { conversationId: "conv_1", runId: "run_1" },
      jobContext().ctx,
    );
    expect([seen[0]?.model, seen[0]?.effort]).toEqual(["sonnet", "high"]);
    expect(out.effort).toBe("high");
    expect(state.completed[0]).toMatchObject({
      model: "claude-opus-5-5",
      usage: { requestedModel: "sonnet", effort: "high", model: "claude-opus-5-5" },
    });
  });

  it("asks a question part when the model needs information", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    const output = {
      reply: "Hangi ay için planlayayım?",
      action: "question",
      question: {
        prompt: "Hangi ay?",
        mode: "single",
        options: [
          { id: "kasim", label: "Kasım" },
          { id: "aralik", label: "Aralık" },
        ],
        allowText: true,
      },
    };
    const handler = createChatTurnHandler(deps(api, streamingRunner(output)));
    const out = await handler.run({ conversationId: "conv_1", runId: "run_1" }, jobContext().ctx);
    expect(out.action).toBe("question");
    expect(state.parts[1]).toMatchObject({ type: "question", prompt: "Hangi ay?", mode: "single" });
    expect(state.plans).toEqual([]);
    expect(state.completed).toHaveLength(1);
  });

  it("sets the brand when the conversation has none and the model picked one", async () => {
    const brands = [fakeBrand(), fakeBrand({ id: "brand_2", name: "Başka", slug: "baska" })];
    const context = turnContext({
      conversation: { ...turnContext().conversation, brandId: null },
      brand: null,
      brandProfile: null,
      aliases: [],
      messages: [
        userMessage({ mentions: [], parts: [{ type: "text", text: "MTM için kasım planı" }] }),
      ],
    });
    const { api, state } = createFakeApi({ context, brands });
    const output = { ...planOutput, plan: { ...planOutput.plan, brandId: "brand_1" } };
    const seen: ClaudeCallOptions[] = [];
    const handler = createChatTurnHandler(deps(api, streamingRunner(output, seen)));
    await handler.run({ conversationId: "conv_1", runId: "run_1" }, jobContext().ctx);
    expect(state.plans[0]?.brandId).toBe("brand_1");
    const first = seen[0]?.content[0];
    expect(first?.type === "text" && first.text).toContain("Başka (slug: baska, id: brand_2)");
  });

  it("parks on a usage limit, shows it in the message, then finishes", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    state.assets.set("asset_photo", { bytes: await png(), contentType: "image/png" });
    let calls = 0;
    const inner = streamingRunner(planOutput);
    const runner: ClaudeRunner = async (options) => {
      calls++;
      if (calls === 1) {
        throw new ClaudeUsageLimitError("limit", new Date(Date.now() + 30), "rate_limit_event");
      }
      return inner(options);
    };
    const handler = createChatTurnHandler(
      deps(api, runner, { resetSlackMs: 0, maxSleepChunkMs: 10 }),
    );
    const { ctx, progress } = jobContext();
    await handler.run({ conversationId: "conv_1", runId: "run_1" }, ctx);
    expect(calls).toBe(2);
    expect(state.parts[0]).toMatchObject({
      type: "progress",
      stepId: "usage-limit",
      state: "done",
      label: "Claude kullanım sınırı doldu",
    });
    const sets = state.opsCalls.flat().filter((op) => op.op === "part.set");
    expect(
      sets.map((s) => (s.op === "part.set" && s.part.type === "progress" ? s.part.state : "")),
    ).toEqual(["pending", "done"]);
    expect(state.parts[1]).toEqual({ type: "text", text: planOutput.reply });
    expect(progress.some(([, m]) => m?.startsWith("Claude kullanım sınırı doldu"))).toBe(true);
    expect(state.completed).toHaveLength(1);
  });

  it("fails the run with a Turkish message when the output is unusable", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    const runner: ClaudeRunner = async () => {
      throw new ClaudeError("output", "no structured output");
    };
    const handler = createChatTurnHandler(deps(api, runner));
    await expect(
      handler.run({ conversationId: "conv_1", runId: "run_1" }, jobContext().ctx),
    ).rejects.toThrow("no structured output");
    expect(state.failed).toEqual([
      { attempt: 1, error: "Claude'un yanıtı beklenen biçimde değildi." },
    ]);
    expect(state.completed).toEqual([]);
  });

  it("leaves the run open for a retry on transient errors", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    const runner: ClaudeRunner = async () => {
      throw new ClaudeError("timeout", "no result after 900000 ms");
    };
    const handler = createChatTurnHandler(deps(api, runner));
    await expect(
      handler.run({ conversationId: "conv_1", runId: "run_1" }, jobContext().ctx),
    ).rejects.toMatchObject({ name: "RetryableError" });
    expect(state.failed).toEqual([]);
  });

  it("stops when the job is cancelled mid-stream", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    const controller = new AbortController();
    const runner: ClaudeRunner = (options) =>
      new Promise((_resolve, reject) => {
        options.onFieldDelta?.("Yazıyor");
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        setTimeout(() => controller.abort(new Error("job cancelled")), 5);
      });
    const handler = createChatTurnHandler(deps(api, runner));
    await expect(
      handler.run({ conversationId: "conv_1", runId: "run_1" }, jobContext(controller.signal).ctx),
    ).rejects.toThrow("job cancelled");
    expect(state.completed).toEqual([]);
    expect(state.failed).toEqual([]);
  });

  it("refuses to call Claude when the self-test found no login", async () => {
    const { api, state } = createFakeApi({ context: turnContext() });
    let called = false;
    const d = deps(api, async () => {
      called = true;
      return result({});
    });
    d.health = () => ({
      state: "unauthenticated",
      message: "Claude oturumu yok/süresi doldu",
      checkedAt: NOW,
    });
    await expect(
      createChatTurnHandler(d).run({ conversationId: "conv_1", runId: "run_1" }, jobContext().ctx),
    ).rejects.toThrow("Claude oturumu yok");
    expect(called).toBe(false);
    expect(state.failed).toEqual([{ attempt: 1, error: "Claude oturumu yok/süresi doldu" }]);
  });
});

describe("splitUtf8", () => {
  it("never exceeds the byte limit or splits a character", () => {
    const text = "ğ😀a".repeat(1000);
    const parts = splitUtf8(text, 100);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(new TextEncoder().encode(p).byteLength).toBeLessThanOrEqual(100);
  });
});
