/**
 * "@postadı bu tasarımı geliştir, devamını getir" (Faz 2): the chat agent recognises a canvas
 * post — the mention says it is on the canvas — and the prompt has it finish the design with the
 * canvas tools, keeping the user's hand-made layers; `canvas_outline` hands it the brand's logos
 * and pictures by asset id. The engine choice now includes Wecra.
 */
import type { Content, TurnContext } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { brandCanvasAssets, CANVAS_TOOLS } from "../src/chat/canvas-tools.ts";
import { CHAT_SYSTEM_PROMPT, mentionBlocks } from "../src/chat/prompt.ts";
import { STUDIO_TOOLS } from "../src/chat/tools.ts";
import { NOW } from "./fake-api.ts";

const post = (overrides: Partial<Content> = {}): Content => ({
  id: "cnt_yarim",
  brandId: "brand_1",
  type: "post",
  title: "Yarım tasarım",
  brief: "",
  status: "draft",
  targetPlatforms: ["instagram"],
  caption: "",
  currentVersion: { id: "ver_1", version: 3, contentHash: "a".repeat(64) },
  approval: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("continuing an unfinished canvas design from the chat", () => {
  it("marks a mentioned canvas post as on the canvas (and an HTML one not)", () => {
    const [block] = mentionBlocks({
      mentionedContents: [
        { mention: "yarim", content: post(), canvas: true },
        { mention: "html-post", content: post({ id: "cnt_html", title: "HTML" }), canvas: false },
      ],
    } as unknown as TurnContext);
    const lines = (block ?? "").split("\n");
    expect(lines.find((l) => l.includes("@yarim"))).toContain("tuvalde (Wecra belgesi");
    expect(lines.find((l) => l.includes("@html-post"))).not.toContain("tuvalde");
  });

  it("has the agent finish it with the canvas tools, keeping the hand-made layers", () => {
    const rule = CHAT_SYSTEM_PROMPT.slice(CHAT_SYSTEM_PROMPT.indexOf("**Yarım tasarımı tamamlama"));
    expect(rule).toContain("devamını getir");
    expect(rule).toContain("canvas_outline");
    expect(rule).toContain("canvas_screenshot");
    expect(rule).toContain("elle yaptığı katmanları KORU");
    expect(rule).toContain("create_nodes");
    expect(rule).toContain("revise_post");
    expect(rule.indexOf("postu yeniden üretme")).toBeGreaterThan(0);
    expect(CHAT_SYSTEM_PROMPT).toContain("HTML ve Wecra motorları çalışır");
    const generate = STUDIO_TOOLS.find((t) => t.name === "generate_post");
    expect(generate?.description).toContain("`wecra`");
    const edit = CANVAS_TOOLS.find((t) => t.name === "canvas_edit");
    expect(edit?.description).toContain("brandAssets");
  });

  it("lists the brand's logos and pictures by asset id for the canvas", async () => {
    const env = {
      signal: new AbortController().signal,
      api: {
        client: {
          brandProfiles: {
            current: async () => ({
              tokens: {
                logos: { primary: { path: "logos/mark.svg" }, gone: { path: "logos/x.png" } },
                assets: { field: { path: "img/field.jpg" } },
                fileAssets: { "logos/mark.svg": "asset_logo", "img/field.jpg": "asset_field" },
              },
            }),
          },
        },
      },
    };
    expect(await brandCanvasAssets(env as never, "brand_1")).toEqual([
      { kind: "logo", name: "primary", assetId: "asset_logo", svg: true },
      { kind: "image", name: "field", assetId: "asset_field" },
    ]);
    const none = {
      ...env,
      api: {
        client: {
          brandProfiles: {
            current: async () => {
              throw Object.assign(new Error("not found"), { status: 404 });
            },
          },
        },
      },
    };
    expect(await brandCanvasAssets(none as never, "brand_1")).toEqual([]);
  });
});
