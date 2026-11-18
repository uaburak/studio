/**
 * The real `studio-vision` helper (Apple Vision on this Mac) end to end: label-preserving
 * composites (U9) and media tagging (N12). Gemini stays mocked. Skipped, with the reason, when the
 * helper is not built (`swift build -c release --package-path apps/vision-helper`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { createImageGenerateHandler } from "../src/image/handler.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import type { RenderCapable } from "../src/render/handler.ts";
import { analyzePicture } from "../src/vision/analyze.ts";
import { createVisionHelper, findVisionHelper } from "../src/vision/helper.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const bin = findVisionHelper({});
const vision = bin ? createVisionHelper({ bin, logger: silentLogger }) : null;
const reason =
  "studio-vision is not built (swift build -c release --package-path apps/vision-helper)";

/** A green bag with a white label (large text) on a busy, non-uniform backdrop. */
async function productPhoto(): Promise<Uint8Array> {
  const blobs: string[] = [];
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 40; i++) {
    const r = 10 + Math.round(rnd() * 35);
    blobs.push(
      `<circle cx="${Math.round(rnd() * 900)}" cy="${Math.round(rnd() * 1125)}" r="${r}" fill="rgb(${Math.round(rnd() * 255)},${Math.round(rnd() * 255)},${Math.round(rnd() * 255)})" fill-opacity="0.35"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c7a880"/><stop offset="1" stop-color="#6b4c38"/></linearGradient></defs>
    <rect width="900" height="1125" fill="url(#g)"/>
    ${blobs.join("")}
    <rect x="198" y="202" width="504" height="742" rx="28" fill="#145428"/>
    <rect x="233" y="350" width="434" height="445" fill="#fafaf5"/>
    <text x="450" y="480" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="64" text-anchor="middle" fill="#111">VENTA</text>
    <text x="450" y="580" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="64" text-anchor="middle" fill="#111">GÜBRE</text>
    <text x="450" y="680" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="64" text-anchor="middle" fill="#111">25 KG</text>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** A soft outdoor scene: sky over a field, empty lower centre. */
async function scenePng(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9cc7f0"/><stop offset="0.55" stop-color="#e8f2fb"/>
      <stop offset="0.56" stop-color="#8a6a3c"/><stop offset="1" stop-color="#5d4526"/></linearGradient></defs>
    <rect width="1080" height="1350" fill="url(#s)"/>
    <circle cx="880" cy="180" r="70" fill="#fff3b0"/>
    <rect x="40" y="620" width="160" height="120" fill="#2f6d2f"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

const renderer: RenderCapable = {
  async render() {
    throw new Error("unused");
  },
  async renderAndLint() {
    throw new Error("unused");
  },
};

function ctx(payload: Record<string, unknown>): JobContext {
  const job: Job = {
    id: "job_real_vision",
    type: "image.generate",
    status: "running",
    brandId: "brand_1",
    payload,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: job.id,
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

describe.skipIf(!vision)(
  `real studio-vision helper${vision ? "" : ` (skipped: ${reason})`}`,
  () => {
    const helper = vision as NonNullable<typeof vision>;

    it("U9: cuts the product off a busy photo, composites it and reads the same label back", async () => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      state.assets.set("ref", { bytes: await productPhoto(), contentType: "image/png" });
      const scene = await scenePng();
      const fetchFn: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: Buffer.from(scene).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      const handler = createImageGenerateHandler({
        api,
        gate: new ClaudeGate({
          runner: async () => {
            throw new Error("unused");
          },
        }),
        settings: loadAgentSettings({ GEMINI_API_KEY: "k-123456" }),
        logger: silentLogger,
        health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        stateDir: mkdtempSync(path.join(tmpdir(), "worker-real-vision-")),
        renderer: () => renderer,
        imageFetch: fetchFn,
        vision: helper,
      });
      const payload = {
        prompt: "Hasat sonrası tarla",
        aspectRatio: "4:5" as const,
        imageSize: "2K" as const,
        referenceAssetIds: ["ref"],
        preserveProductLabel: true,
      };
      const out = await handler.run(payload, ctx(payload));
      expect(out).toMatchObject({
        cutout: "vision",
        labelCheck: { status: "ok", source: "ocr", missing: [] },
        width: 1080,
        height: 1350,
      });
      const expected = (out.labelCheck as { expected: string[] }).expected.join(" ");
      expect(expected).toMatch(/VENTA/);
      expect(expected).toMatch(/25 KG/);

      // The owner's text with a different number: reported, not passed off as right.
      const wrong = { ...payload, labelText: "VENTA\nGÜBRE\n50 KG" };
      const out2 = await handler.run(wrong, { ...ctx(wrong), jobId: "job_real_vision_2" });
      expect(out2).toMatchObject({ labelCheck: { status: "mismatch", missing: ["50 KG"] } });
    }, 180_000);

    it("N12: tags a picture with Turkish labels, its text, colours and a feature print", async () => {
      const analysis = await analyzePicture(
        {
          api: createFakeApi().api,
          logger: silentLogger,
          settings: loadAgentSettings({}),
          stateDir: mkdtempSync(path.join(tmpdir(), "worker-real-tags-")),
          vision: helper,
        },
        await productPhoto(),
      );
      expect(analysis.status).toBe("complete");
      // (librsvg draws Ü / Ç poorly in this fixture, so only the plain lines are checked.)
      expect(analysis.text).toMatch(/VENTA/);
      expect(analysis.text).toMatch(/25 KG/);
      expect(analysis.tags?.length ?? 0).toBeGreaterThan(0);
      expect(analysis.featurePrint?.count).toBe(768);
      expect(analysis.orientation).toBe("portrait");
      expect(analysis.colors?.length ?? 0).toBeGreaterThan(0);
    }, 180_000);
  },
);
