/**
 * Pluggable Voiceover (TTS) providers for Reels (`PLAN.md` §7):
 * - `ElevenLabsTtsProvider`: `/v1/text-to-speech/{voiceId}/with-timestamps` (exact character -> word alignment),
 * - `MacSayTtsProvider`: local offline macOS `/usr/bin/say` + `ffmpeg` AAC conversion with syllable-weighted word timings,
 * - `SilentOrCustomAudioProvider`: uploaded `audio` asset or `ffmpeg` `anullsrc` stereo silence.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type FfmpegRunner, generateSilentAac, REELS_FFMPEG_AUDIO_ARGS } from "./ffmpeg.ts";

const execFileAsync = promisify(nodeExecFile);

export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsSynthesisResult {
  audioBytes: Uint8Array;
  mimeType: string;
  durationMs: number;
  words: WordTimestamp[];
}

export interface TtsSynthesizeInput {
  text: string;
  voiceId?: string;
  language?: string;
  durationMs?: number;
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult>;
}

const TURKISH_VOWELS = /[aeıioöuüAEIİOÖUÜ]/g;

function syllableWeight(word: string): number {
  const vowels = word.match(TURKISH_VOWELS)?.length ?? 0;
  const base = Math.max(1, vowels, Math.ceil(word.replace(/[^\p{L}\p{N}]/gu, "").length / 2.6));
  const pauseBonus = /[.!?…]$/.test(word) ? 1.4 : /[,;:—–-]$/.test(word) ? 0.6 : 0;
  return base + pauseBonus;
}

/**
 * Estimate word-level timestamps proportionally by Turkish syllable/character weight
 * and punctuation pauses when exact character alignments are not returned by the engine.
 */
export function estimateWordTimestamps(text: string, durationMs: number): WordTimestamp[] {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return [];

  const totalMs = Math.max(tokens.length * 120, Math.round(durationMs));
  const leadInMs = Math.min(150, Math.round(totalMs * 0.04));
  const tailOutMs = Math.min(200, Math.round(totalMs * 0.05));
  const activeSpanMs = Math.max(tokens.length * 80, totalMs - leadInMs - tailOutMs);

  const weights = tokens.map(syllableWeight);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || tokens.length;

  let cursor = leadInMs;
  return tokens.map((word, idx) => {
    const w = weights[idx] ?? 1;
    const rawDur = (w / totalWeight) * activeSpanMs;
    const startMs = Math.round(cursor);
    cursor += rawDur;
    const endMs =
      idx === tokens.length - 1
        ? Math.max(startMs + 60, totalMs - tailOutMs)
        : Math.max(startMs + 60, Math.round(cursor - Math.min(35, rawDur * 0.08)));
    return { word, startMs, endMs };
  });
}

interface ElevenLabsAlignment {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

export function wordsFromCharacterAlignment(
  alignment: ElevenLabsAlignment | undefined,
  fallbackText: string,
  fallbackDurationMs: number,
): { words: WordTimestamp[]; durationMs: number } {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (
    !Array.isArray(chars) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    chars.length === 0 ||
    chars.length !== starts.length ||
    chars.length !== ends.length
  ) {
    return {
      words: estimateWordTimestamps(fallbackText, fallbackDurationMs),
      durationMs: fallbackDurationMs,
    };
  }

  const words: WordTimestamp[] = [];
  let currentWord = "";
  let wordStartSec: number | null = null;
  let wordEndSec = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    const s = starts[i] ?? 0;
    const e = ends[i] ?? s;
    if (/\s/.test(ch)) {
      if (currentWord.length > 0 && wordStartSec !== null) {
        words.push({
          word: currentWord,
          startMs: Math.max(0, Math.round(wordStartSec * 1000)),
          endMs: Math.max(Math.round(wordStartSec * 1000) + 40, Math.round(wordEndSec * 1000)),
        });
        currentWord = "";
        wordStartSec = null;
      }
    } else {
      if (wordStartSec === null) wordStartSec = s;
      currentWord += ch;
      wordEndSec = Math.max(wordEndSec, e);
    }
  }
  if (currentWord.length > 0 && wordStartSec !== null) {
    words.push({
      word: currentWord,
      startMs: Math.max(0, Math.round(wordStartSec * 1000)),
      endMs: Math.max(Math.round(wordStartSec * 1000) + 40, Math.round(wordEndSec * 1000)),
    });
  }

  const lastEndMs = Math.round((ends.at(-1) ?? 0) * 1000);
  const durationMs = Math.max(fallbackDurationMs, lastEndMs + 150, words.at(-1)?.endMs ?? 0);
  return {
    words: words.length > 0 ? words : estimateWordTimestamps(fallbackText, durationMs),
    durationMs,
  };
}

export interface ElevenLabsTtsOptions {
  apiKey: string;
  defaultVoiceId?: string;
  modelId?: string;
  fetch?: typeof globalThis.fetch;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  private readonly doFetch: typeof globalThis.fetch;
  private readonly defaultVoiceId: string;
  private readonly modelId: string;

  constructor(private readonly options: ElevenLabsTtsOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultVoiceId = options.defaultVoiceId ?? "21m00Tcm4TlvDq8ikWAM";
    this.modelId = options.modelId ?? "eleven_multilingual_v2";
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const apiKey = this.options.apiKey.trim();
    if (!apiKey) {
      throw new Error("ElevenLabs seslendirme için ELEVENLABS_API_KEY tanımlı değil.");
    }
    const voiceId = input.voiceId ?? this.defaultVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: this.modelId,
        ...(input.language ? { language_code: input.language.split("-")[0] } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).split(apiKey).join("[REDACTED]");
      throw new Error(`ElevenLabs TTS hatası (HTTP ${res.status}): ${errText.slice(0, 240)}`);
    }

    const body = (await res.json()) as {
      audio_base64?: string;
      alignment?: ElevenLabsAlignment;
      normalized_alignment?: ElevenLabsAlignment;
    };
    if (!body.audio_base64) {
      throw new Error("ElevenLabs yanıtında ses verisi (audio_base64) bulunamadı.");
    }
    const buf = Buffer.from(body.audio_base64, "base64");
    const audioBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const estDurationMs =
      input.durationMs ?? Math.max(2000, input.text.trim().split(/\s+/).length * 420);
    const { words, durationMs } = wordsFromCharacterAlignment(
      body.alignment ?? body.normalized_alignment,
      input.text,
      estDurationMs,
    );

    return {
      audioBytes,
      mimeType: "audio/mpeg",
      durationMs,
      words,
    };
  }
}

export type SayCommandRunner = (
  bin: string,
  args: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export interface MacSayTtsOptions {
  ffmpeg: FfmpegRunner;
  sayBin?: string;
  voice?: string;
  exec?: SayCommandRunner;
}

function parseFfmpegDurationMs(stderr: string): number | null {
  const m = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export class MacSayTtsProvider implements TtsProvider {
  readonly name = "mac-say";
  private readonly sayBin: string;
  private readonly exec: SayCommandRunner;

  constructor(private readonly options: MacSayTtsOptions) {
    this.sayBin = options.sayBin ?? "/usr/bin/say";
    this.exec =
      options.exec ??
      (async (bin, args, opts) => {
        const res = await execFileAsync(bin, [...args], {
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        return { stdout: String(res.stdout), stderr: String(res.stderr) };
      });
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const workDir = await mkdtemp(path.join(tmpdir(), "studio-say-"));
    const aiffPath = path.join(workDir, "speech.aiff");
    const aacPath = path.join(workDir, "speech.m4a");
    try {
      const preferredVoice =
        input.voiceId ??
        this.options.voice ??
        (input.language === undefined || input.language.startsWith("tr") ? "Yelda" : undefined);

      const runSay = async (voice?: string) => {
        const args = [...(voice ? ["-v", voice] : []), "-o", aiffPath, input.text];
        await this.exec(this.sayBin, args, input.signal ? { signal: input.signal } : undefined);
      };

      try {
        await runSay(preferredVoice);
      } catch (err) {
        if (preferredVoice && !input.signal?.aborted) {
          // Fallback to default macOS system voice if Turkish voice pack isn't installed
          await runSay(undefined);
        } else {
          throw err;
        }
      }

      const ffRes = await this.options.ffmpeg(
        ["-hide_banner", "-y", "-i", aiffPath, ...REELS_FFMPEG_AUDIO_ARGS, aacPath],
        input.signal ? { signal: input.signal } : {},
      );

      let audioBytes: Uint8Array;
      try {
        audioBytes = new Uint8Array(await readFile(aacPath));
      } catch {
        audioBytes =
          ffRes.stdout.byteLength > 0 ? ffRes.stdout : new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
      }

      const wordCount = Math.max(1, input.text.trim().split(/\s+/).filter(Boolean).length);
      const measuredMs = parseFfmpegDurationMs(ffRes.stderr);
      const durationMs = measuredMs ?? input.durationMs ?? Math.max(2000, wordCount * 430);
      const words = estimateWordTimestamps(input.text, durationMs);

      return {
        audioBytes,
        mimeType: "audio/mp4",
        durationMs,
        words,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface SilentOrCustomAudioOptions {
  ffmpeg: FfmpegRunner;
  customAudio?: {
    bytes: Uint8Array;
    mimeType: string;
    durationMs?: number | null;
  };
}

export class SilentOrCustomAudioProvider implements TtsProvider {
  readonly name = "silent-or-custom";

  constructor(private readonly options: SilentOrCustomAudioOptions) {}

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    if (this.options.customAudio) {
      const wordCount = Math.max(1, input.text.trim().split(/\s+/).filter(Boolean).length);
      const durationMs =
        this.options.customAudio.durationMs ?? input.durationMs ?? Math.max(4000, wordCount * 420);
      return {
        audioBytes: this.options.customAudio.bytes,
        mimeType: this.options.customAudio.mimeType,
        durationMs,
        words: input.text.trim() ? estimateWordTimestamps(input.text, durationMs) : [],
      };
    }

    const durationMs = input.durationMs ?? 6000;
    const audioBytes = await generateSilentAac(durationMs, this.options.ffmpeg, input.signal);
    return {
      audioBytes,
      mimeType: "audio/aac",
      durationMs,
      words: input.text.trim() ? estimateWordTimestamps(input.text, durationMs) : [],
    };
  }
}

export function selectTtsProvider(options: {
  recipe: "motion_graphics" | "footage_edit" | "narration";
  elevenLabsApiKey?: string | undefined;
  elevenLabsVoiceId?: string | undefined;
  customAudio?: { bytes: Uint8Array; mimeType: string; durationMs?: number | null } | undefined;
  ffmpeg: FfmpegRunner;
  fetch?: typeof globalThis.fetch;
  sayExec?: SayCommandRunner;
}): TtsProvider {
  if (options.customAudio) {
    return new SilentOrCustomAudioProvider({
      ffmpeg: options.ffmpeg,
      customAudio: options.customAudio,
    });
  }
  if (options.recipe !== "narration") {
    return new SilentOrCustomAudioProvider({ ffmpeg: options.ffmpeg });
  }
  if (options.elevenLabsApiKey?.trim()) {
    return new ElevenLabsTtsProvider({
      apiKey: options.elevenLabsApiKey,
      ...(options.elevenLabsVoiceId ? { defaultVoiceId: options.elevenLabsVoiceId } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  if (process.platform === "darwin" || options.sayExec) {
    return new MacSayTtsProvider({
      ffmpeg: options.ffmpeg,
      ...(options.sayExec ? { exec: options.sayExec } : {}),
    });
  }
  return new SilentOrCustomAudioProvider({ ffmpeg: options.ffmpeg });
}
