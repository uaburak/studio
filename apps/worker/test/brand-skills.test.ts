import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Asset,
  type BrandKit,
  type BrandSkill,
  BrandSkillDraftPayload,
  type Job,
  type TurnContext,
} from "@studio/contract";
import { generateBrandCss, parseBrandTokens } from "@studio/design-kit/brand";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { buildValidatedBrandTokens } from "../src/brand/handler.ts";
import { createBrandSkillDraftHandler } from "../src/brand/skill-draft.ts";
import {
  brandSkillsUsed,
  chatSkillsBlock,
  designSkillsBlock,
  selectBrandSkills,
  skillScore,
} from "../src/brand/skills.ts";
import {
  brandSkillsOutput,
  buildConversationMetadataBlock,
  buildIncrementalChatPrompt,
} from "../src/chat/prompt.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, fakeRun, NOW } from "./fake-api.ts";

function fakeTurnContext({ text }: { text: string }): TurnContext {
  return {
    run: fakeRun(),
    conversation: {
      id: "conv_1",
      brandId: "brand_1",
      title: "Kasım",
      status: "active",
      activeRunId: "run_1",
      lastSeq: 3,
      agentSession: null,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    brand: fakeBrand(),
    brandProfile: null,
    messages: [
      {
        id: "msg_1",
        conversationId: "conv_1",
        role: "user",
        status: "complete",
        runId: null,
        parts: [{ type: "text", text }],
        mentions: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    messagesTruncated: false,
    assets: [],
    openPlan: null,
    assistantMessage: null,
    aliases: [],
    messageCount: 1,
  };
}

function skill(overrides: Partial<BrandSkill> = {}): BrandSkill {
  return {
    id: `skill_${overrides.name ?? "mtm"}`,
    brandId: "brand_1",
    name: "mtm",
    description: "MTM Agro tek görsel post formatı",
    body: "# MTM\n- 1080×1350, kenar 72 px.\n- Başlık sol üstte.",
    enabled: true,
    version: 3,
    origin: "manual",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("brand skills in prompts", () => {
  it("puts the skills that fit the task first and keeps within the budget", () => {
    const skills = [
      skill({ name: "partner", description: "Bayi ve partner duyuruları", version: 1 }),
      skill({
        name: "carousel",
        description: "Kaydırmalı carousel formatı",
        body: "x".repeat(5000),
      }),
      skill({ name: "mtm", body: "y".repeat(3000) }),
      skill({ name: "kapali", enabled: false }),
      skill({ name: "uzun", description: "Çok uzun bir rehber", body: "z\n".repeat(6000) }),
    ];
    expect(skillScore(skills[1] as BrandSkill, "Bir carousel hazırla")).toBeGreaterThan(
      skillScore(skills[0] as BrandSkill, "Bir carousel hazırla"),
    );
    const selected = selectBrandSkills(skills, {
      budget: 9_000,
      task: "Hasat için 5 slaytlık bir carousel hazırla",
    });
    // Disabled skills never come; the carousel skill fits the task best.
    expect(selected.map((s) => s.skill.name)).toEqual(["carousel", "mtm", "partner", "uzun"]);
    expect(selected.map((s) => s.inclusion)).toEqual(["full", "full", "full", "listed"]);
    expect(brandSkillsUsed(selected)).toEqual([
      "carousel v3",
      "mtm v3",
      "partner v1",
      "uzun v3 (yalnızca adı)",
    ]);

    const tight = selectBrandSkills(skills, { budget: 7_000, task: "carousel" });
    expect(tight.map((s) => s.inclusion)).toEqual(["full", "clipped", "listed", "listed"]);
    expect(tight[1]?.text).toContain("[… kısaltıldı]");
    expect(tight.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(7_000 + 20);

    const chat = chatSkillsBlock(selected);
    expect(chat).toContain('<skill ad="carousel" surum="3"');
    expect(chat).toContain("- uzun: Çok uzun bir rehber");
    const design = designSkillsBlock(selected);
    expect(design).toContain("<brand_skills>");
    expect(design).toContain('<skill name="mtm" version="3"');
    expect(designSkillsBlock([])).toBe("");
  });

  it("chat turns of the brand carry its skills; resumed sessions get only changed ones", () => {
    const context = fakeTurnContext({ text: "MTM için post planla" });
    context.brandSkills = [
      skill(),
      skill({ name: "partner", version: 1, updatedAt: "2026-11-16T12:00:00.000Z" }),
    ];
    const meta = buildConversationMetadataBlock({
      context,
      now: new Date(NOW),
      brands: [],
      images: [],
    });
    expect(meta).toContain("<marka_skilleri>");
    expect(meta).toContain('<skill ad="mtm" surum="3"');
    expect(brandSkillsOutput(context)).toEqual({ brandSkills: ["mtm v3", "partner v1"] });

    context.conversation.agentSession = {
      id: "session-1",
      messageCount: 2,
      runId: "run_old",
      updatedAt: "2026-11-16T11:00:00.000Z",
    };
    const resumed = buildIncrementalChatPrompt({ context, now: new Date(NOW), images: [] });
    expect(resumed).toContain('<skill ad="partner" surum="1"');
    expect(resumed).not.toContain('<skill ad="mtm"');

    // Without a brand there are none.
    const noBrand = fakeTurnContext({ text: "selam" });
    noBrand.brand = null;
    noBrand.brandSkills = [skill()];
    expect(brandSkillsOutput(noBrand)).toEqual({});
  });
});

describe("system fonts in brand tokens", () => {
  it("uses a kit's installed fonts by name, with a same-family file as the fallback", () => {
    const fontAsset: Asset = {
      id: "font_avenir",
      brandId: "brand_1",
      kind: "font",
      source: "upload",
      objectKey: "k",
      mimeType: "font/woff2",
      bytes: 10,
      sha256: "0".repeat(64),
      width: null,
      height: null,
      durationMs: null,
      originalFilename: "AvenirNext-Bold.woff2",
      createdAt: NOW,
    };
    const kit: BrandKit = {
      brandId: "brand_1",
      logos: [],
      fonts: [
        {
          source: "system",
          family: "Avenir Next",
          role: "display",
          styles: [
            { name: "Demi Bold", weight: 600, italic: false },
            { name: "Heavy", weight: 900, italic: false },
          ],
          licenseNote: "Apple",
        },
        {
          source: "file",
          assetId: "font_avenir",
          family: "Avenir Next",
          role: "display",
          styles: [],
          licenseNote: "",
        },
        {
          source: "system",
          family: "Helvetica Neue",
          role: "text",
          styles: [],
          licenseNote: "",
        },
      ],
      palette: [],
      samples: [],
      notes: "",
      updatedAt: NOW,
    };
    const tokens = buildValidatedBrandTokens({
      brand: fakeBrand(),
      existingProfile: null,
      uploadedAssets: [fontAsset],
      kit,
      analyzed: {
        colors: {},
        displayFontFamily: "Inter",
        textFontFamily: "Inter",
        marginPx: 72,
        designRules: "x",
        voice: "y",
        allowedNumbers: [],
        statements: [],
        forbiddenClaims: [],
        provisional: false,
      },
    });
    const parsed = parseBrandTokens(tokens);
    expect(parsed.font.display).toMatchObject({
      family: "Avenir Next",
      system: true,
      weights: [600, 900],
      files: ["fonts/avenirnext-bold.woff2"],
      default: { weight: 900 },
      license: "Avenir Next: Apple",
    });
    expect(parsed.font.text).toMatchObject({
      family: "Helvetica Neue",
      system: true,
      files: [],
      default: { weight: 400 },
    });
    const { css, manifest } = generateBrandCss(parsed);
    expect(css).toContain("--font-display: 'Avenir Next', 'Avenir Next Fallback', sans-serif;");
    expect(manifest.systemFontFamilies).toEqual(["Avenir Next", "Helvetica Neue"]);
  });
});

describe("brand.skill_draft", () => {
  function ctx(payload: Record<string, unknown>): JobContext {
    const job: Job = {
      id: "job_draft",
      type: "brand.skill_draft",
      status: "running",
      payload,
      brandId: "brand_1",
      createdAt: NOW,
      updatedAt: NOW,
    };
    return {
      job,
      jobId: job.id,
      attempt: 1,
      signal: new AbortController().signal,
      progress: () => undefined,
    } as unknown as JobContext;
  }

  it("drafts a disabled skill from the brand's kit and profile (mocked model)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.kits.set("brand_1", {
      brandId: "brand_1",
      logos: [],
      fonts: [
        { source: "system", family: "Avenir Next", role: "any", styles: [], licenseNote: "" },
      ],
      palette: [{ name: "accent", hex: "#FF6A00", use: "tek vurgu" }],
      samples: [],
      notes: "Tek turuncu vurgu, siyah beyaz.",
      updatedAt: NOW,
    });
    state.skills.push(skill({ name: "carousel" }));
    let prompt = "";
    const geminiFetch: typeof fetch = async (_url, init) => {
      prompt = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      name: "carousel",
                      description: "Carousel formatı: kapak, 3-5 içerik slaytı, kapanış",
                      body: "# Carousel\n\n## Ölçüler\n- 1080×1350\n\n## Yapma\n- Kapakta logo büyütme.",
                    }),
                  },
                ],
              },
            },
          ],
          modelVersion: "gemini-2.5-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const handler = createBrandSkillDraftHandler({
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("Claude should not be called while limited");
        },
      }),
      settings: loadAgentSettings({ GEMINI_API_KEY: "fake-skill-key" }),
      logger: silentLogger,
      health: () => ({ state: "limited", message: "limit dolu", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "worker-skill-draft-")),
      geminiFetch,
    });
    const payload = BrandSkillDraftPayload.parse({ focus: "carousel formatı" });
    const out = await handler.run(payload, ctx(payload));

    // "carousel" is taken: the draft gets the next free name, switched off.
    expect(out).toMatchObject({ name: "carousel-2", version: 1, enabled: false });
    const created = state.skills.at(-1);
    expect(created).toMatchObject({
      name: "carousel-2",
      enabled: false,
      origin: "ai_draft",
      description: "Carousel formatı: kapak, 3-5 içerik slaytı, kapanış",
    });
    expect(created?.body).toContain("## Ölçüler");
    expect(prompt).toContain("carousel formatı");
    expect(prompt).toContain("accent: #FF6A00");
    expect(prompt).toContain("Avenir Next");
    // Existing skills are shown so the draft does not repeat them.
    expect(prompt).toContain("carousel");
  });
});
