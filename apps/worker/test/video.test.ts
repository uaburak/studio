import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Content } from "@studio/contract";
import { createRenderer, isChromiumAvailable } from "@studio/design-kit/render";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import {
  createDefaultClipTranscriber,
  ElevenLabsTtsProvider,
  estimateWordTimestamps,
  extractReelVersionAssets,
  generateAndRenderReel,
  MacSayTtsProvider,
  REELS_FFMPEG_AUDIO_ARGS,
  REELS_FFMPEG_CONTAINER_ARGS,
  REELS_FFMPEG_VIDEO_ARGS,
  resolveFfmpegBin,
  SilentOrCustomAudioProvider,
} from "../src/video/index.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

function makeReelContent(id = "cnt_reel"): Content {
  return {
    id,
    brandId: "brand_1",
    type: "reel",
    title: "Bor ve Çinko Dengesi",
    brief: "Tarlada doğru besleme anlatımı.",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function dummyFramePng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1080, height: 1920, channels: 4, background: "#16301A" } })
      .png()
      .toBuffer(),
  );
}

describe("TTS providers (ElevenLabs, MacSay, SilentOrCustom)", () => {
  it("parses ElevenLabs character alignment into word-level timestamps", async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      expect(String(url)).toContain("/v1/text-to-speech/voice_tr/with-timestamps");
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("el_test_key");
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from("MP3_BYTES").toString("base64"),
          alignment: {
            characters: ["T", "o", "p", "r", "a", "k", " ", "h", "a", "z", "ı", "r"],
            character_start_times_seconds: [
              0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.42, 0.5, 0.56, 0.62, 0.68, 0.74,
            ],
            character_end_times_seconds: [
              0.15, 0.2, 0.25, 0.3, 0.35, 0.42, 0.5, 0.56, 0.62, 0.68, 0.74, 0.85,
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      defaultVoiceId: "voice_tr",
      fetch: fakeFetch,
    });
    const res = await provider.synthesize({ text: "Toprak hazır", language: "tr" });
    expect(res.mimeType).toBe("audio/mpeg");
    expect(res.words).toEqual([
      { word: "Toprak", startMs: 100, endMs: 420 },
      { word: "hazır", startMs: 500, endMs: 850 },
    ]);
  });

  it("synthesizes local Turkish speech via MacSayTtsProvider + ffmpeg and estimates word timings", async () => {
    const sayCalls: { bin: string; args: readonly string[] }[] = [];
    const provider = new MacSayTtsProvider({
      exec: async (bin, args) => {
        sayCalls.push({ bin, args });
        return { stdout: "", stderr: "" };
      },
      ffmpeg: async () => ({
        stdout: new Uint8Array([1, 2, 3, 4]),
        stderr: "  Duration: 00:00:02.40, start: 0.000000, bitrate: 128 kb/s",
      }),
    });

    const res = await provider.synthesize({
      text: "Doğru dozda güçlü gelişim sağlar.",
      language: "tr",
    });
    expect(sayCalls[0]?.args).toContain("Yelda");
    expect(res.durationMs).toBe(2400);
    expect(res.words.map((w) => w.word)).toEqual(["Doğru", "dozda", "güçlü", "gelişim", "sağlar."]);
    expect(res.words[0]?.startMs).toBeGreaterThanOrEqual(0);
    expect(res.words.at(-1)?.endMs).toBeLessThanOrEqual(2400);
  });

  it("supports SilentOrCustomAudioProvider for silent motion graphics and uploaded audio", async () => {
    const silent = new SilentOrCustomAudioProvider({
      ffmpeg: async (args) => {
        expect(args).toContain("anullsrc=r=48000:cl=stereo");
        return { stdout: new Uint8Array([0xff, 0xf1]), stderr: "" };
      },
    });
    const outSilent = await silent.synthesize({ text: "", durationMs: 5000 });
    expect(outSilent.durationMs).toBe(5000);
    expect(outSilent.words).toEqual([]);

    const custom = new SilentOrCustomAudioProvider({
      ffmpeg: async () => ({ stdout: new Uint8Array(), stderr: "" }),
      customAudio: { bytes: new Uint8Array([9, 8, 7]), mimeType: "audio/mp4", durationMs: 4200 },
    });
    const outCustom = await custom.synthesize({ text: "Kendi ses kaydım", durationMs: 6000 });
    expect(outCustom.durationMs).toBe(4200);
    expect(outCustom.words).toHaveLength(3);
    expect(estimateWordTimestamps("Tek kelime", 1000)).toHaveLength(2);
  });
});

describe("Clip transcription (whisper-cli & Gemini multimodal)", () => {
  it("parses whisper-cli JSON output when whisperBin is provided", async () => {
    const transcriber = createDefaultClipTranscriber({
      whisperBin: "/fake/whisper-cli",
      execWhisper: async (_bin, args) => {
        const ofIdx = args.indexOf("-of");
        const outPrefix = args[ofIdx + 1] as string;
        writeFileSync(
          `${outPrefix}.json`,
          JSON.stringify({
            transcription: [
              { text: " Merhaba çiftçi dostlar", offsets: { from: 0, to: 1800 } },
              { text: " bugün bor uyguluyoruz.", offsets: { from: 1800, to: 3900 } },
            ],
          }),
        );
        return { stdout: "", stderr: "" };
      },
    });

    const res = await transcriber({
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "video/mp4",
      language: "tr",
    });
    expect(res.provider).toBe("whisper-cli");
    expect(res.segments).toEqual([
      { text: "Merhaba çiftçi dostlar", startMs: 0, endMs: 1800 },
      { text: "bugün bor uyguluyoruz.", startMs: 1800, endMs: 3900 },
    ]);
  });

  it("transcribes clips via Gemini multimodal when whisper-cli is absent", async () => {
    const transcriber = createDefaultClipTranscriber({
      whisperBin: null,
      geminiApiKey: "fake-transcribe-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          contents: { parts: { inlineData?: { mimeType: string } }[] }[];
        };
        expect(body.contents[0]?.parts[1]?.inlineData?.mimeType).toBe("video/mp4");
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        language: "tr",
                        text: "Tarlada sabah kontrolü",
                        segments: [{ text: "Tarlada sabah kontrolü", startMs: 100, endMs: 2200 }],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const res = await transcriber({
      bytes: new Uint8Array([10, 20, 30]),
      mimeType: "video/mp4",
    });
    expect(res.provider).toBe("gemini");
    expect(res.segments[0]?.text).toBe("Tarlada sabah kontrolü");
  });
});

describe("All 3 Reels recipes & FFmpeg normalization flags", () => {
  it("renders motion_graphics, footage_edit, and narration recipes with exact Reels FFmpeg flags", async () => {
    const framePng = await dummyFramePng();

    for (const recipe of ["motion_graphics", "footage_edit", "narration"] as const) {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      const content = makeReelContent(`cnt_${recipe}`);
      state.contents.set(content.id, content);

      if (recipe === "footage_edit") {
        state.assets.set("asset_clip", {
          bytes: new Uint8Array([0, 0, 0, 24]),
          contentType: "video/mp4",
        });
      }

      const seenFfmpegArgs: string[][] = [];
      let capturedHtml = "";

      const deps: AgentDeps = {
        api,
        gate: new ClaudeGate({
          runner: async () => ({
            output: {
              hook: `${recipe} kancası`,
              scenes: [
                { eyebrow: "MTM", headline: "Sahne 1", subhead: "Detay", durationSec: 1.5 },
                { eyebrow: "", headline: "Sahne 2", subhead: "", durationSec: 1.5 },
              ],
              narrationScript: "Toprağın ihtiyacı doğru zamanda karşılanır.",
              overlays: [{ startMs: 0, endMs: 2500, caption: "Saha kesiti altyazısı" }],
              cta: "mtmagro.com",
              caption: `${recipe} açıklaması #mtm`,
              durationSec: 3,
            },
            text: "",
            model: "claude-opus-5-5",
            cliVersion: "2.1.292",
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0.01,
              durationMs: 10,
              durationApiMs: 10,
              wallMs: 10,
            },
            rateLimit: undefined,
          }),
        }),
        settings: loadAgentSettings({}),
        logger: silentLogger,
        health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        stateDir: mkdtempSync(path.join(tmpdir(), `reel-${recipe}-`)),
      };

      const out = await generateAndRenderReel({
        deps,
        seams: {
          frameCapturer: async (req) => {
            capturedHtml = req.html;
            return { frames: [framePng, framePng], coverPng: framePng };
          },
          ffmpeg: async (args) => {
            seenFfmpegArgs.push([...args]);
            return { stdout: new TextEncoder().encode("MP4_DATA"), stderr: "" };
          },
          ttsProvider: {
            name: "mock-tts",
            synthesize: async ({ text }) => ({
              audioBytes: new Uint8Array([1, 2, 3]),
              mimeType: "audio/mpeg",
              durationMs: 3000,
              words: text ? estimateWordTimestamps(text, 3000) : [],
            }),
          },
          transcriber: async () => ({
            language: "tr",
            text: "Saha kaydı",
            segments: [{ text: "Saha kaydı", startMs: 0, endMs: 2000 }],
            provider: "whisper-cli",
          }),
        },
        jobId: `job_${recipe}`,
        brandId: "brand_1",
        content,
        title: content.title,
        brief: content.brief,
        explicitRecipe: recipe,
        ...(recipe === "footage_edit" ? { videoClipAssetId: "asset_clip" } : {}),
        signal: new AbortController().signal,
        progress: () => {},
      });

      expect(out.recipe).toBe(recipe);
      expect(capturedHtml).toContain("window.__seek");
      if (recipe === "narration") {
        expect(capturedHtml).toContain("karaoke-bar");
      } else if (recipe === "footage_edit") {
        expect(capturedHtml).toContain("caption-box");
      } else {
        expect(capturedHtml).toContain("progress-bar");
      }

      const muxArgs = seenFfmpegArgs.at(-1) ?? [];
      for (const flag of REELS_FFMPEG_VIDEO_ARGS) {
        expect(muxArgs).toContain(flag);
      }
      for (const flag of REELS_FFMPEG_AUDIO_ARGS) {
        expect(muxArgs).toContain(flag);
      }
      for (const flag of REELS_FFMPEG_CONTAINER_ARGS) {
        expect(muxArgs).toContain(flag);
      }

      const storedVer = state.versions[0];
      expect(storedVer).toBeDefined();
      if (storedVer) {
        const extracted = extractReelVersionAssets(storedVer);
        expect(extracted.videoAssetId).toBe(out.videoAssetId);
        expect(extracted.coverAssetId).toBe(out.coverAssetId);
        expect(extracted.recipe).toBe(recipe);
      }
    }
  });
});

const chromiumOk = await isChromiumAvailable();
const realFfmpegBin = resolveFfmpegBin();

describe.skipIf(!chromiumOk || !realFfmpegBin || process.env.STUDIO_SKIP_RENDER === "1")(
  "Reels end-to-end with real Chromium + real FFmpeg",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

    it("renders a real 1080x1920 30fps H.264/AAC faststart MP4 and sRGB cover JPEG", async () => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      const content = makeReelContent("cnt_real_mp4");
      state.contents.set(content.id, content);

      const deps: AgentDeps = {
        api,
        gate: new ClaudeGate({
          runner: async () => ({
            output: {
              hook: "Gerçek Video Testi",
              scenes: [
                {
                  eyebrow: "MTM AGRO",
                  headline: "Doğru zamanda doğru besleme",
                  subhead: "1080x1920 Reels",
                  durationSec: 1.2,
                },
              ],
              narrationScript: "",
              overlays: [],
              cta: "mtmagro.com",
              caption: "Test #reels",
              durationSec: 1.2,
            },
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
          }),
        }),
        settings: loadAgentSettings({}),
        logger: silentLogger,
        health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        stateDir: mkdtempSync(path.join(tmpdir(), "reel-real-")),
      };

      const out = await generateAndRenderReel({
        deps,
        renderer,
        jobId: "job_real_mp4",
        brandId: "brand_1",
        content,
        title: "Gerçek Video Testi",
        brief: "Kısa motion graphics testi",
        explicitRecipe: "motion_graphics",
        signal: new AbortController().signal,
        progress: () => {},
      });

      const mp4 = state.assets.get(out.videoAssetId)?.bytes ?? new Uint8Array();
      expect(mp4.byteLength).toBeGreaterThan(1000);
      // Verify ISO BMFF `ftyp` box near start of MP4 and `moov` before `mdat` (`+faststart`)
      const ascii = new TextDecoder("latin1").decode(mp4);
      expect(ascii.slice(4, 8)).toBe("ftyp");
      expect(ascii.indexOf("moov")).toBeGreaterThan(0);
      expect(ascii.indexOf("moov")).toBeLessThan(ascii.indexOf("mdat"));

      const cover = state.assets.get(out.coverAssetId)?.bytes ?? new Uint8Array();
      const coverMeta = await sharp(cover).metadata();
      expect([coverMeta.width, coverMeta.height, coverMeta.format]).toEqual([1080, 1920, "jpeg"]);
    }, 30_000);
  },
);
