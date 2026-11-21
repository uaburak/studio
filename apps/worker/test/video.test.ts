import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Content, ReelSpec, type ReelSpecInput, readReelVersionInfo } from "@studio/contract";
import { isChromiumAvailable } from "@studio/design-kit/render";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import {
  applyReelPatch,
  buildReelEncodeArgs,
  buildReelVersionSlideHtml,
  captionChunks,
  clearElevenLabsVoiceCache,
  createDefaultClipTranscriber,
  ELEVENLABS_NO_TURKISH_VOICE,
  ElevenLabsTtsProvider,
  type ElevenLabsVoice,
  estimateWordTimestamps,
  FFMPEG_MISSING_MESSAGE,
  type FfmpegRunner,
  generateAndRenderReel,
  inferReelRecipe,
  MAC_TURKISH_VOICE_MISSING,
  MacSayTtsProvider,
  normalizeSpec,
  parseFfmpegProbe,
  parseSayVoices,
  parseWhisperJson,
  REEL_MAX_FILE_BYTES,
  type ReelEngineTestSeams,
  reelVideoBitrate,
  renderExistingReelVersion,
  resolveFfmpegBin,
  type SayCommandRunner,
  splitSentences,
  WHISPER_MISSING_NOTE,
} from "../src/video/index.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

/** `say -v ?` output (macOS 26 format). */
const SAY_VOICES = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Eddy (Turkish (Turkey)) tr_TR    # Merhaba! Benim adım Eddy.",
  "Fiona               en-scotland # Hello, my name is Fiona.",
  "Yelda               tr_TR    # Merhaba, benim adım Yelda.",
  "",
].join("\n");

function reelContent(id = "cnt_reel"): Content {
  return {
    id,
    brandId: "brand_1",
    type: "reel",
    title: "Bor ve Çinko Dengesi",
    brief: "Tarlada doğru besleme anlatımı.",
    status: "draft",
    targetPlatforms: ["instagram", "facebook"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const PLAN = {
  hook: "Toprağın dili: bor",
  scenes: [
    { eyebrow: "MTM", headline: "Toprağın dili: bor", subhead: "", durationSec: 2.5 },
    { eyebrow: "", headline: "Çiçeklenmede kritik", subhead: "Meyve tutumu", durationSec: 2.5 },
  ],
  narrationScript: "Çiçeklenmede bor eksikliği verimi düşürür. Doğru zamanda besleyin.",
  overlays: [{ startMs: 2400, endMs: 5000, caption: "Yapraklarda şekil bozukluğu" }],
  cta: "mtmagro.com",
  caption: "Bor neden önemli? #mtm",
  durationSec: 6,
};

function aiDeps(
  api: AgentDeps["api"],
  opts: { health?: "ok" | "unauthenticated"; plan?: unknown; calls?: string[] } = {},
): AgentDeps {
  return {
    api,
    gate: new ClaudeGate({
      runner: async (req) => {
        opts.calls?.push(JSON.stringify(req));
        return {
          output: opts.plan ?? PLAN,
          text: "",
          model: "claude-sonnet",
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
        };
      },
    }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () =>
      opts.health === "unauthenticated"
        ? { state: "unauthenticated", message: "Claude oturumu yok", checkedAt: NOW }
        : { state: "ok", message: "ok", checkedAt: NOW },
    stateDir: mkdtempSync(path.join(tmpdir(), "reel-test-")),
  };
}

/** Fake ffmpeg: answers probes, records every call, writes nothing. */
function fakeFfmpeg(
  calls: string[][],
  probe = "Duration: 00:00:14.00, start: 0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080\n  Stream #0:1: Audio: aac, 48000 Hz",
): FfmpegRunner {
  return async (args, opts) => {
    calls.push([...args]);
    if (args.length === 3 && args[1] === "-i") return { stdout: new Uint8Array(), stderr: probe };
    if (opts?.stdin && typeof opts.stdin === "object" && Symbol.asyncIterator in opts.stdin) {
      for await (const _frame of opts.stdin as AsyncIterable<Uint8Array>) {
        // consume like ffmpeg reading the pipe
      }
    }
    return { stdout: new Uint8Array(), stderr: "" };
  };
}

function seams(
  calls: string[][],
  extra: Partial<ReelEngineTestSeams> = {},
): ReelEngineTestSeams & { html: string[] } {
  const html: string[] = [];
  return {
    html,
    ffmpeg: fakeFfmpeg(calls),
    frameCapturer: async function* (req) {
      html.push(req.html);
      yield new Uint8Array([1]);
    },
    ttsProvider: {
      name: "mock-tts",
      synthesize: async ({ text, workDir }) => {
        const audioPath = path.join(workDir, "voice.m4a");
        writeFileSync(audioPath, "AUDIO");
        return {
          audioPath,
          durationMs: 4200,
          words: estimateWordTimestamps(text, 4200),
          provider: "mock-tts",
        };
      },
    },
    transcriber: async () => ({
      language: "tr",
      text: "Bugün tarladayız",
      segments: [{ text: "Bugün tarladayız", startMs: 300, endMs: 1500 }],
      words: [
        { word: "Bugün", startMs: 300, endMs: 800 },
        { word: "tarladayız", startMs: 800, endMs: 1500 },
      ],
      provider: "whisper-cli",
    }),
    ...extra,
  };
}

describe("ffmpeg discovery and the Reels encoder", () => {
  it("explains a missing ffmpeg in Turkish with the brew fix", () => {
    expect(resolveFfmpegBin({ STUDIO_FFMPEG_BIN: "/nope/ffmpeg", PATH: "" })).toBeNull();
    expect(FFMPEG_MISSING_MESSAGE).toContain("ffmpeg gerekli");
  });

  it("keeps every reel under the 50 MiB asset limit", () => {
    expect(reelVideoBitrate(8_000)).toBe(8_000_000);
    for (const sec of [30, 60, 90]) {
      const bytes = ((reelVideoBitrate(sec * 1000) * 1.0 + 128_000) * sec) / 8;
      expect(bytes).toBeLessThanOrEqual(REEL_MAX_FILE_BYTES);
    }
  });

  it("builds one encode pass with the bake-off flags, footage under transparent frames and the clip's audio", () => {
    const args = buildReelEncodeArgs({
      frameFormat: "png",
      durationMs: 12_000,
      outPath: "/tmp/out.mp4",
      clip: { path: "/tmp/clip.mp4", startMs: 1500, loop: false },
      audio: { fromClip: true },
    });
    const joined = args.join(" ");
    for (const flag of [
      "-c:v libx264",
      "-threads 1",
      "-profile:v high",
      "-pix_fmt yuv420p",
      "-r 30",
      "-g 60",
      "-keyint_min 60",
      "-sc_threshold 0",
      "-flags +cgop",
      "-color_range tv",
      "-colorspace bt709",
      "-c:a aac",
      "-ar 48000",
      "-ac 2",
      "-movflags +faststart+negative_cts_offsets",
      "-use_editlist 0",
      "-t 12.000",
    ]) {
      expect(joined).toContain(flag);
    }
    expect(joined).toContain("-c:v png -framerate 30 -i pipe:0");
    expect(joined).toContain("-ss 1.500 -i /tmp/clip.mp4");
    expect(joined).toContain("overlay=0:0");
    expect(joined).toContain("[1:a]aresample");
  });

  it("reads duration and streams from ffmpeg -i output", () => {
    const p = parseFfmpegProbe(
      "  Duration: 00:01:02.50, start: 0.0\n    Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080\n",
    );
    expect(p).toEqual({
      durationMs: 62_500,
      hasAudio: false,
      hasVideo: true,
      width: 1920,
      height: 1080,
    });
  });
});

describe("voice-over and transcription", () => {
  it("spreads words over the measured duration and splits sentences", () => {
    const words = estimateWordTimestamps("Toprak hazır mı? Evet.", 2000, 500);
    expect(words.map((w) => w.word)).toEqual(["Toprak", "hazır", "mı?", "Evet."]);
    expect(words[0]?.startMs).toBeGreaterThanOrEqual(500);
    expect(words.at(-1)?.endMs).toBeLessThanOrEqual(2500);
    expect(splitSentences("Bir. İki! Üç")).toEqual(["Bir.", "İki!", "Üç"]);
  });

  it("macOS say: Turkish voice, AAC, sentence-measured word timings", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "say-"));
    const sayCalls: string[][] = [];
    const lengths = [3000, 1000, 2000];
    let probes = 0;
    const ffmpeg: FfmpegRunner = async (args) => {
      if (args[1] === "-i" && args.length === 3) {
        const ms = lengths[probes++] ?? 0;
        return { stdout: new Uint8Array(), stderr: `Duration: 00:00:0${ms / 1000}.00` };
      }
      return { stdout: new Uint8Array(), stderr: "" };
    };
    const tts = new MacSayTtsProvider({
      ffmpeg,
      exec: async (_bin, args) => {
        if (args[1] === "?") return { stdout: SAY_VOICES, stderr: "" };
        sayCalls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    });
    const res = await tts.synthesize({
      text: "Bor önemli. Çinko da önemli.",
      language: "tr",
      workDir: dir,
    });
    expect(sayCalls[0]?.slice(0, 2)).toEqual(["-v", "Yelda"]);
    expect(sayCalls.every((c) => c[1] === "Yelda")).toBe(true);
    expect(res.durationMs).toBe(3000);
    expect(res.provider).toBe("mac-say:Yelda");
    expect(res.note).toBeUndefined();
    // Sentence 1 measured 1 s of 3 s total: its words end by ~1 s.
    expect(res.words.find((w) => w.word === "önemli.")?.endMs).toBeLessThanOrEqual(1000);
    expect(res.words.find((w) => w.word === "Çinko")?.startMs).toBeGreaterThanOrEqual(1000);
  });

  it("macOS say: lists voices by locale", () => {
    expect(parseSayVoices(SAY_VOICES)).toEqual([
      { name: "Albert", locale: "en_US" },
      { name: "Eddy (Turkish (Turkey))", locale: "tr_TR" },
      { name: "Fiona", locale: "en_scotland" },
      { name: "Yelda", locale: "tr_TR" },
    ]);
  });

  /** `say` stand-in: answers `-v ?` with `voices`, records synthesis calls. */
  function fakeSay(voices: string | Error, calls: string[][]): SayCommandRunner {
    return async (_bin, args) => {
      if (args[0] === "-v" && args[1] === "?") {
        if (voices instanceof Error) throw voices;
        return { stdout: voices, stderr: "" };
      }
      calls.push([...args]);
      if (args[0] === "-v" && args[1] === "Missing") throw new Error("Voice `Missing' not found.");
      return { stdout: "", stderr: "" };
    };
  }
  const silentFfmpeg: FfmpegRunner = async (args) =>
    args[1] === "-i" && args.length === 3
      ? { stdout: new Uint8Array(), stderr: "Duration: 00:00:02.00" }
      : { stdout: new Uint8Array(), stderr: "" };

  it("macOS say: no Yelda → another Turkish voice; no Turkish voice → clear error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "say-"));
    const calls: string[][] = [];
    const withoutYelda = SAY_VOICES.split("\n")
      .filter((l) => !l.startsWith("Yelda"))
      .join("\n");
    const other = await new MacSayTtsProvider({
      ffmpeg: silentFfmpeg,
      exec: fakeSay(withoutYelda, calls),
    }).synthesize({ text: "Bor önemli.", workDir: dir });
    expect(calls[0]?.slice(0, 2)).toEqual(["-v", "Eddy (Turkish (Turkey))"]);
    expect(other.provider).toBe("mac-say:Eddy (Turkish (Turkey))");

    const englishOnly = "Albert              en_US    # Hello! My name is Albert.\n";
    calls.length = 0;
    const noTurkish = new MacSayTtsProvider({
      ffmpeg: silentFfmpeg,
      exec: fakeSay(englishOnly, calls),
    });
    const error = await noTurkish
      .synthesize({ text: "Bor önemli.", language: "tr-TR", workDir: dir })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(MAC_TURKISH_VOICE_MISSING);
    expect((error as Error).message).toContain("Sesli İçerik → Sistem sesi → Ses Yönet…");
    expect(calls).toEqual([]); // nothing synthesised with an English voice

    // Non-Turkish text keeps working with the system voice.
    const english = await noTurkish.synthesize({ text: "Hello.", language: "en", workDir: dir });
    expect(calls[0]?.slice(0, 2)).toEqual(["-o", path.join(dir, "voice.aiff")]);
    expect(english.provider).toBe("mac-say");
  });

  it("macOS say: an asked voice that is missing is reported, not silently swapped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "say-"));
    const calls: string[][] = [];
    const tr = await new MacSayTtsProvider({
      ffmpeg: silentFfmpeg,
      exec: fakeSay(SAY_VOICES, calls),
    }).synthesize({ text: "Bor önemli.", voice: "Cem", workDir: dir });
    expect(tr.provider).toBe("mac-say:Yelda");
    expect(tr.note).toContain("“Cem” sesi bu Mac'te yüklü değil; Yelda kullanıldı.");

    const en = await new MacSayTtsProvider({
      ffmpeg: silentFfmpeg,
      exec: fakeSay(SAY_VOICES, calls),
    }).synthesize({ text: "Hello.", voice: "Samantha", language: "en-US", workDir: dir });
    expect(en.provider).toBe("mac-say");
    expect(en.note).toContain("sistem sesi");

    // Voices cannot be listed and the Turkish voice fails: the install hint, not English.
    const unlisted = new MacSayTtsProvider({
      ffmpeg: silentFfmpeg,
      exec: fakeSay(new Error("say: no voices"), calls),
      voice: "Missing",
    });
    await expect(unlisted.synthesize({ text: "Bor.", workDir: dir })).rejects.toThrow(
      MAC_TURKISH_VOICE_MISSING,
    );
  });

  it("ElevenLabs: character alignment to words, audio written to the work dir", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "el-"));
    const tts = new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      defaultVoiceId: "voice_configured",
      fetch: async (url, init) => {
        expect(String(url)).toContain("/with-timestamps");
        expect(new Headers(init?.headers).get("xi-api-key")).toBe("el_test_key");
        return new Response(
          JSON.stringify({
            audio_base64: Buffer.from("MP3").toString("base64"),
            alignment: {
              characters: ["B", "o", "r", " ", "v", "e"],
              character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
              character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
            },
          }),
        );
      },
    });
    const res = await tts.synthesize({ text: "Bor ve", workDir: dir });
    expect(res.words).toEqual([
      { word: "Bor", startMs: 0, endMs: 300 },
      { word: "ve", startMs: 400, endMs: 600 },
    ]);
    expect(res.audioPath.endsWith("voice.mp3")).toBe(true);
    expect(res.billing).toEqual({ model: "eleven_multilingual_v2", characters: 6 });
  });

  /** ElevenLabs stand-in: `GET /v1/voices` answers `voices`, TTS calls are recorded. */
  function fakeElevenLabs(voices: ElevenLabsVoice[], urls: string[], ttsStatus = 200) {
    return (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/voices")) return new Response(JSON.stringify({ voices }));
      if (ttsStatus !== 200) return new Response('{"detail":"voice_not_found"}', { status: 404 });
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from("MP3").toString("base64"),
          alignment: {
            characters: ["Ç", "o", "k"],
            character_start_times_seconds: [0, 0.1, 0.2],
            character_end_times_seconds: [0.1, 0.2, 0.3],
          },
        }),
      );
    }) as typeof fetch;
  }

  const ACCOUNT_VOICES: ElevenLabsVoice[] = [
    // Premade English voice: never used for Turkish text.
    { voice_id: "premade_en", name: "Rachel", labels: { accent: "american", language: "en" } },
    {
      voice_id: "multi_verified",
      name: "Multi",
      labels: { accent: "american" },
      verified_languages: [{ language: "en" }, { language: "tr", locale: "tr-TR" }],
    },
    { voice_id: "tr_native", name: "Ahmet", labels: { language: "tr", accent: "istanbul" } },
  ];

  it("ElevenLabs: no voice set → a Turkish voice from the account, cached; spend fields filled", async () => {
    clearElevenLabsVoiceCache();
    const dir = mkdtempSync(path.join(tmpdir(), "el-"));
    const urls: string[] = [];
    const tts = new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      modelId: "eleven_turbo_v2_5",
      fetch: fakeElevenLabs(ACCOUNT_VOICES, urls),
    });
    const res = await tts.synthesize({ text: "Çok güzel", language: "tr", workDir: dir });
    expect(urls[0]).toBe("https://api.elevenlabs.io/v1/voices");
    expect(urls[1]).toContain("/v1/text-to-speech/tr_native/with-timestamps");
    expect(res.billing).toEqual({ model: "eleven_turbo_v2_5", characters: 9 });

    // Second reel: the voice list is not read again.
    await tts.synthesize({ text: "Bor", workDir: dir });
    expect(urls.filter((u) => u.endsWith("/v1/voices"))).toHaveLength(1);
    expect(urls[2]).toContain("/tr_native/");

    // Only a "verified for Turkish" voice: still fine.
    clearElevenLabsVoiceCache();
    urls.length = 0;
    await new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      fetch: fakeElevenLabs(ACCOUNT_VOICES.slice(0, 2), urls),
    }).synthesize({ text: "Bor", workDir: dir });
    expect(urls[1]).toContain("/multi_verified/");
  });

  it("ElevenLabs: no Turkish voice in the account → clear Turkish error, nothing synthesised", async () => {
    clearElevenLabsVoiceCache();
    const dir = mkdtempSync(path.join(tmpdir(), "el-"));
    const urls: string[] = [];
    const tts = new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      fetch: fakeElevenLabs(ACCOUNT_VOICES.slice(0, 1), urls),
    });
    await expect(tts.synthesize({ text: "Bor", language: "tr-TR", workDir: dir })).rejects.toThrow(
      ELEVENLABS_NO_TURKISH_VOICE,
    );
    expect(ELEVENLABS_NO_TURKISH_VOICE).toContain("STUDIO_ELEVENLABS_VOICE_ID");
    expect(urls).toEqual(["https://api.elevenlabs.io/v1/voices"]);

    // Other languages use a voice of that language (else any account voice).
    const en = await tts.synthesize({ text: "Hi", language: "en", workDir: dir });
    expect(urls.at(-1)).toContain("/premade_en/");
    expect(en.provider).toBe("elevenlabs");
  });

  it("ElevenLabs: a found voice that stopped working is looked up again", async () => {
    clearElevenLabsVoiceCache();
    const dir = mkdtempSync(path.join(tmpdir(), "el-"));
    const urls: string[] = [];
    const broken = new ElevenLabsTtsProvider({
      apiKey: "el_test_key",
      fetch: fakeElevenLabs(ACCOUNT_VOICES, urls, 404),
    });
    await expect(broken.synthesize({ text: "Bor", workDir: dir })).rejects.toThrow(/HTTP 404/);
    await expect(broken.synthesize({ text: "Bor", workDir: dir })).rejects.toThrow(/HTTP 404/);
    expect(urls.filter((u) => u.endsWith("/v1/voices"))).toHaveLength(2);
  });

  it("STUDIO_ELEVENLABS_VOICE_ID has no English default", () => {
    expect(loadAgentSettings({}).elevenLabsVoiceId).toBeUndefined();
    expect(loadAgentSettings({ STUDIO_ELEVENLABS_VOICE_ID: "v_tr" }).elevenLabsVoiceId).toBe(
      "v_tr",
    );
  });

  it("whisper.cpp: 16 kHz WAV, word-level JSON, [music] tags dropped", async () => {
    const calls: string[][] = [];
    const whisperArgs: string[][] = [];
    const transcribe = createDefaultClipTranscriber({
      ffmpeg: fakeFfmpeg(calls),
      whisperBin: "/opt/homebrew/bin/whisper-cli",
      whisperModel: "/models/ggml-small.bin",
      execWhisper: async (_bin, args) => {
        whisperArgs.push([...args]);
        const prefix = args[args.indexOf("-of") + 1] ?? "";
        writeFileSync(
          `${prefix}.json`,
          JSON.stringify({
            transcription: [
              { text: " [Müzik]", offsets: { from: 0, to: 300 } },
              { text: " Bugün", offsets: { from: 300, to: 700 } },
              { text: " tarladayız.", offsets: { from: 700, to: 1400 } },
            ],
          }),
        );
        return { stdout: "", stderr: "" };
      },
    });
    const res = await transcribe({
      path: "/tmp/clip.mp4",
      mimeType: "video/mp4",
      language: "tr-TR",
      startMs: 1000,
      durationMs: 8000,
    });
    expect(calls[0]?.join(" ")).toContain(
      "-ss 1.000 -i /tmp/clip.mp4 -t 8.000 -vn -ac 1 -ar 16000",
    );
    expect(whisperArgs[0]).toEqual(
      expect.arrayContaining([
        "-m",
        "/models/ggml-small.bin",
        "-l",
        "tr",
        "-ml",
        "1",
        "-sow",
        "-oj",
      ]),
    );
    expect(res.provider).toBe("whisper-cli");
    expect(res.words).toEqual([
      { word: "Bugün", startMs: 300, endMs: 700 },
      { word: "tarladayız.", startMs: 700, endMs: 1400 },
    ]);
    expect(res.segments).toEqual([{ text: "Bugün tarladayız.", startMs: 300, endMs: 1400 }]);
  });

  it("without whisper or Gemini: no transcript and a Turkish note with the brew fix", async () => {
    const transcribe = createDefaultClipTranscriber({
      ffmpeg: fakeFfmpeg([]),
      env: { PATH: "", HOME: "/nonexistent" },
    });
    const res = await transcribe({ path: "/tmp/c.mp4", mimeType: "video/mp4" });
    expect(res.provider).toBe("none");
    expect(res.note).toBe(WHISPER_MISSING_NOTE);
    expect(res.note).toContain("whisper.cpp kurulu değil");
    expect(parseWhisperJson({ transcription: [] }).words).toEqual([]);
  });
});

describe("reel specs and compositions", () => {
  it("infers the recipe from media and wording", () => {
    expect(inferReelRecipe({ brief: "x", hasVideoClip: true })).toBe("footage_edit");
    expect(inferReelRecipe({ brief: "Seslendirmeli kısa anlatım" })).toBe("narration");
    expect(inferReelRecipe({ brief: "Ürün tanıtımı" })).toBe("motion_graphics");
    expect(inferReelRecipe({ brief: "x", explicitRecipe: "narration", hasVideoClip: true })).toBe(
      "narration",
    );
  });

  it("motion duration follows the scenes (+ closing card) and stays within the platform limit", () => {
    const spec = ReelSpec.parse({
      recipe: "motion_graphics",
      hook: "a",
      cta: "b",
      scenes: [
        { headline: "x", durationMs: 2000 },
        { headline: "y", durationMs: 3000 },
      ],
      durationMs: 60_000,
    });
    expect(normalizeSpec(spec).durationMs).toBe(6800);
    const long = ReelSpec.parse({
      recipe: "footage_edit",
      durationMs: 90_000,
      overlays: [{ text: "t", startMs: 80_000, endMs: 89_000 }],
    });
    expect(normalizeSpec(long, 30_000).overlays).toEqual([]);
  });

  it("caption chunks hold until the next chunk and break at punctuation", () => {
    const chunks = captionChunks([
      { word: "Bor", startMs: 0, endMs: 300 },
      { word: "önemli.", startMs: 300, endMs: 700 },
      { word: "Çinko", startMs: 900, endMs: 1200 },
    ]);
    expect(chunks.map((c) => c.words.map((w) => w.word).join(" "))).toEqual([
      "Bor önemli.",
      "Çinko",
    ]);
    expect(chunks[0]?.endMs).toBe(900);
  });

  it("a changed narration script drops the stored voice; other edits keep it", () => {
    const spec = ReelSpec.parse({
      recipe: "narration",
      narrationScript: "Eski metin.",
      words: [{ word: "Eski", startMs: 0, endMs: 300 }],
      voiceAssetId: "voice_1",
      durationMs: 5000,
    });
    expect(applyReelPatch(spec, { hook: "Yeni" }).voiceAssetId).toBe("voice_1");
    const changed = applyReelPatch(spec, { narrationScript: "Yeni metin." });
    expect(changed.voiceAssetId).toBeNull();
    expect(changed.words).toEqual([]);
  });

  it("the version slide carries the spec, video, cover and duration", () => {
    const spec = ReelSpec.parse({
      recipe: "motion_graphics",
      hook: "Kanca ‘ğüşiöç’ <b>",
      durationMs: 4000,
    });
    const html = buildReelVersionSlideHtml({ spec, videoAssetId: "vid_1", coverAssetId: "cov_1" });
    const info = readReelVersionInfo(html);
    expect(info).toMatchObject({
      videoAssetId: "vid_1",
      coverAssetId: "cov_1",
      durationMs: 4000,
      recipe: "motion_graphics",
    });
    expect(info.spec?.hook).toBe(spec.hook);
    expect(html).toContain('src="/media/cov_1.jpg"');
  });
});

describe("generateAndRenderReel", () => {
  it("plans with the AI, renders each recipe and stores video + cover (+ voice) as a reel version", async () => {
    for (const recipe of ["motion_graphics", "footage_edit", "narration"] as const) {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      const content = reelContent(`cnt_${recipe}`);
      state.contents.set(content.id, content);
      state.assets.set("asset_clip", { bytes: new Uint8Array([0]), contentType: "video/mp4" });
      const calls: string[][] = [];
      const s = seams(calls);
      const progress: string[] = [];
      const out = await generateAndRenderReel({
        deps: aiDeps(api),
        seams: s,
        jobId: `job_${recipe}`,
        brandId: "brand_1",
        content,
        title: content.title,
        brief: content.brief,
        options: { recipe, ...(recipe === "footage_edit" ? { clipAssetId: "asset_clip" } : {}) },
        signal: new AbortController().signal,
        progress: (_v, m) => progress.push(m),
      });
      expect(out.recipe).toBe(recipe);
      expect(out.provider).toBe("claude");
      expect(s.html[0]).toContain("window.__seek");
      const stored = state.versionCreates.at(-1);
      const info = readReelVersionInfo(stored?.slides[0]?.html ?? "");
      expect(info.videoAssetId).toBe(out.videoAssetId);
      expect(info.coverAssetId).toBe(out.coverAssetId);
      expect(stored?.renderedAssetIds).toEqual([out.coverAssetId]);
      expect(info.spec?.recipe).toBe(recipe);
      const encode = calls.find((a) => a.includes("pipe:0")) ?? [];
      expect(encode.join(" ")).toContain("-movflags +faststart+negative_cts_offsets");
      expect(progress).toContain("Tamamlandı");
      if (recipe === "narration") {
        expect(state.uploads.map((u) => u.kind)).toEqual(["audio", "video", "image"]);
        expect(info.spec?.words.length).toBeGreaterThan(3);
        expect(info.spec?.voiceAssetId).toBe(state.uploads.length ? "asset_gen_1" : null);
        expect(s.html[0]).toContain('id="captions"');
        expect(info.spec?.durationMs).toBe(4900);
      }
      if (recipe === "footage_edit") {
        expect(info.spec?.words.map((w) => w.word)).toEqual(["Bugün", "tarladayız"]);
        expect(info.spec?.clipAssetId).toBe("asset_clip");
        expect(encode.join(" ")).toContain("overlay=0:0");
        expect(encode.join(" ")).toContain("-c:v png");
      }
      if (recipe === "motion_graphics") {
        expect(info.spec?.durationMs).toBe(6800); // 2.5 + 2.5 + 1.8 closing card
        expect(state.uploads.map((u) => u.kind)).toEqual(["video", "image"]);
      }
    }
  });

  it("renders a given spec without any AI call and falls back to a template when no AI is available", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const content = reelContent();
    state.contents.set(content.id, content);
    const aiCalls: string[] = [];
    const spec: ReelSpecInput = {
      recipe: "motion_graphics",
      hook: "Hazır",
      scenes: [{ headline: "Hazır", durationMs: 3000 }],
      durationMs: 3000,
    };
    const out = await generateAndRenderReel({
      deps: aiDeps(api, { calls: aiCalls }),
      seams: seams([]),
      jobId: "job_spec",
      brandId: "brand_1",
      content,
      title: "t",
      brief: "b",
      options: { spec: ReelSpec.parse(spec) },
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(out.provider).toBe("spec");
    expect(aiCalls).toHaveLength(0);

    const offline = await generateAndRenderReel({
      deps: aiDeps(api, { health: "unauthenticated", calls: aiCalls }),
      seams: seams([]),
      jobId: "job_tpl",
      brandId: "brand_1",
      content,
      title: "Hasat",
      brief: "Hasat zamanı. Toprak hazır.",
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(offline.provider).toBe("template");
    expect(aiCalls).toHaveLength(0);
    expect(offline.warnings.join(" ")).toContain("şablon");
  });

  it('"Neyi değiştireyim?" revises the stored spec with the AI and keeps the media', async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const content = reelContent();
    state.contents.set(content.id, content);
    const first = await generateAndRenderReel({
      deps: aiDeps(api),
      seams: seams([]),
      jobId: "job_1",
      brandId: "brand_1",
      content,
      title: "t",
      brief: "b",
      options: { recipe: "motion_graphics", heroAssetId: "hero_1" },
      signal: new AbortController().signal,
      progress: () => {},
    });
    const prompts: string[] = [];
    const revised = await generateAndRenderReel({
      deps: aiDeps(api, { plan: { ...PLAN, hook: "Daha kısa kanca" }, calls: prompts }),
      seams: seams([]),
      jobId: "job_2",
      brandId: "brand_1",
      content,
      title: "t",
      brief: "b",
      instructions: "Kancayı kısalt",
      baseVersion: first.version,
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(prompts.join(" ")).toContain("Kancayı kısalt");
    expect(revised).toMatchObject({ revised: true, baseVersion: first.version });
    const created = state.versionCreates.at(-1);
    expect(created?.origin).toBe("ai_edit");
    const spec = readReelVersionInfo(created?.slides[0]?.html ?? "").spec;
    expect(spec?.hook).toBe("Daha kısa kanca");
    expect(spec?.heroAssetId).toBe("hero_1");
  });

  it("editor patch re-renders without AI; a too-short clip is refused in Turkish", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const content = reelContent();
    state.contents.set(content.id, content);
    await generateAndRenderReel({
      deps: aiDeps(api),
      seams: seams([]),
      jobId: "job_1",
      brandId: "brand_1",
      content,
      title: "t",
      brief: "b",
      options: { recipe: "motion_graphics" },
      signal: new AbortController().signal,
      progress: () => {},
    });
    const version = state.versions.at(-1);
    if (!version) throw new Error("no version");
    const aiCalls: string[] = [];
    const out = await renderExistingReelVersion({
      deps: aiDeps(api, { calls: aiCalls }),
      seams: seams([]),
      jobId: "job_edit",
      brandId: "brand_1",
      content,
      version,
      patch: {
        scenes: [{ eyebrow: "", headline: "Tek sahne", subhead: "", durationMs: 4000 }],
        cta: "",
      },
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(aiCalls).toHaveLength(0);
    expect(out).toMatchObject({ durationMs: 4000, baseVersion: version.version });
    expect(state.versionCreates.at(-1)?.origin).toBe("manual_edit");

    state.assets.set("short", { bytes: new Uint8Array([0]), contentType: "video/mp4" });
    await expect(
      generateAndRenderReel({
        deps: aiDeps(api),
        seams: seams([], {
          ffmpeg: fakeFfmpeg([], "Duration: 00:00:02.00\n Stream #0:0: Video: h264, 1080x1920"),
        }),
        jobId: "job_short",
        brandId: "brand_1",
        content,
        title: "t",
        brief: "b",
        options: {
          recipe: "footage_edit",
          spec: ReelSpec.parse({ recipe: "footage_edit", clipAssetId: "short", durationMs: 5000 }),
        },
        signal: new AbortController().signal,
        progress: () => {},
      }),
    ).rejects.toThrow(/Çekim çok kısa/);
  });

  it("stops at once when cancelled", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const content = reelContent();
    state.contents.set(content.id, content);
    const ac = new AbortController();
    const s = seams([], {
      frameCapturer: async function* (req) {
        ac.abort(new Error("İş iptal edildi"));
        req.signal.throwIfAborted();
        yield new Uint8Array();
      },
      ffmpeg: async (args, opts) => {
        if (opts?.stdin && Symbol.asyncIterator in (opts.stdin as object)) {
          for await (const _ of opts.stdin as AsyncIterable<Uint8Array>) {
            // drain
          }
        }
        return { stdout: new Uint8Array(), stderr: args.join(" ") };
      },
    });
    await expect(
      generateAndRenderReel({
        deps: aiDeps(api),
        seams: s,
        jobId: "job_c",
        brandId: "brand_1",
        content,
        title: "t",
        brief: "b",
        options: { recipe: "motion_graphics" },
        signal: ac.signal,
        progress: () => {},
      }),
    ).rejects.toThrow(/iptal/);
    expect(state.versionCreates).toHaveLength(0);
  });
});

const chromiumOk = await isChromiumAvailable();
const realFfmpeg = resolveFfmpegBin();

describe.skipIf(!chromiumOk || !realFfmpeg || process.env.STUDIO_SKIP_RENDER === "1")(
  "Reels with real Chromium + real ffmpeg",
  () => {
    it("renders a conformant 1080×1920 30 fps H.264/AAC faststart MP4 and a cover JPEG", async () => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      const content = reelContent("cnt_real");
      state.contents.set(content.id, content);
      const out = await generateAndRenderReel({
        deps: aiDeps(api),
        jobId: "job_real",
        brandId: "brand_1",
        content,
        title: "Gerçek",
        brief: "b",
        options: {
          spec: ReelSpec.parse({
            recipe: "motion_graphics",
            hook: "Gerçek video",
            scenes: [{ headline: "Gerçek video testi", durationMs: 3000 }],
            durationMs: 3000,
          }),
        },
        signal: new AbortController().signal,
        progress: () => {},
      });
      const mp4 = state.assets.get(out.videoAssetId)?.bytes ?? new Uint8Array();
      const ascii = new TextDecoder("latin1").decode(mp4);
      expect(ascii.slice(4, 8)).toBe("ftyp");
      expect(ascii.indexOf("moov")).toBeLessThan(ascii.indexOf("mdat"));
      expect(ascii).toContain("avc1");
      expect(ascii).toContain("mp4a");
      expect(ascii.includes("elst")).toBe(false);
      expect(out.frames).toBe(90);
      const cover = state.assets.get(out.coverAssetId)?.bytes ?? new Uint8Array();
      const meta = await sharp(cover).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([1080, 1920, "jpeg"]);
    }, 60_000);
  },
);
