/**
 * Voice-over for `narration` reels, with word timings for burned-in captions.
 * - `ElevenLabsTtsProvider`: `/v1/text-to-speech/{voiceId}/with-timestamps` (character alignment).
 *   Used only when `ELEVENLABS_API_KEY` is set (paid).
 * - `MacSayTtsProvider`: offline macOS `say` (Turkish voice "Yelda"); every sentence is also
 *   measured on its own so the captions follow the real sentence rhythm, words inside a
 *   sentence are spread by Turkish syllable weight.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type FfmpegRunner, probeMedia, transcodeAudioToAac } from "./ffmpeg.ts";

const execFileAsync = promisify(nodeExecFile);

export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsSynthesisResult {
  /** AAC (`.m4a`) or MP3 file in the caller's work dir. */
  audioPath: string;
  durationMs: number;
  words: WordTimestamp[];
  provider: string;
}

export interface TtsSynthesizeInput {
  text: string;
  voice?: string | null;
  language?: string;
  workDir: string;
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult>;
}

const TURKISH_VOWELS = /[aeıioöuüâîûAEIİOÖUÜÂÎÛ]/g;

function syllableWeight(word: string): number {
  const vowels = word.match(TURKISH_VOWELS)?.length ?? 0;
  const base = Math.max(1, vowels, Math.ceil(word.replace(/[^\p{L}\p{N}]/gu, "").length / 2.6));
  const pauseBonus = /[.!?…]$/.test(word) ? 1.4 : /[,;:—–-]$/.test(word) ? 0.6 : 0;
  return base + pauseBonus;
}

/** Spread `text`'s words over `[offsetMs, offsetMs + durationMs]` by syllable weight. */
export function estimateWordTimestamps(
  text: string,
  durationMs: number,
  offsetMs = 0,
): WordTimestamp[] {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return [];
  const totalMs = Math.max(tokens.length * 120, Math.round(durationMs));
  const leadInMs = Math.min(120, Math.round(totalMs * 0.03));
  const tailOutMs = Math.min(180, Math.round(totalMs * 0.05));
  const span = Math.max(tokens.length * 80, totalMs - leadInMs - tailOutMs);
  const weights = tokens.map(syllableWeight);
  const total = weights.reduce((sum, w) => sum + w, 0) || tokens.length;
  let cursor = leadInMs;
  return tokens.map((word, idx) => {
    const raw = ((weights[idx] ?? 1) / total) * span;
    const startMs = Math.round(cursor);
    cursor += raw;
    const endMs = Math.max(startMs + 60, Math.round(cursor - Math.min(35, raw * 0.08)));
    return { word: word.slice(0, 60), startMs: startMs + offsetMs, endMs: endMs + offsetMs };
  });
}

/** Sentences (keeps the punctuation). */
export function splitSentences(text: string): string[] {
  return (
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?…]+[.!?…]*/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? []
  );
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
  let current = "";
  let startSec: number | null = null;
  let endSec = 0;
  const push = () => {
    if (current && startSec !== null) {
      words.push({
        word: current.slice(0, 60),
        startMs: Math.max(0, Math.round(startSec * 1000)),
        endMs: Math.max(Math.round(startSec * 1000) + 40, Math.round(endSec * 1000)),
      });
    }
    current = "";
    startSec = null;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    if (/\s/.test(ch)) {
      push();
    } else {
      if (startSec === null) startSec = starts[i] ?? 0;
      current += ch;
      endSec = Math.max(endSec, ends[i] ?? starts[i] ?? 0);
    }
  }
  push();
  const lastEndMs = Math.round((ends.at(-1) ?? 0) * 1000);
  const durationMs = Math.max(lastEndMs + 150, words.at(-1)?.endMs ?? 0);
  return {
    words: words.length > 0 ? words : estimateWordTimestamps(fallbackText, durationMs),
    durationMs,
  };
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  private readonly doFetch: typeof globalThis.fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      defaultVoiceId?: string;
      modelId?: string;
      fetch?: typeof globalThis.fetch;
    },
  ) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const apiKey = this.options.apiKey.trim();
    const voiceId = input.voice ?? this.options.defaultVoiceId ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await this.doFetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          text: input.text,
          model_id: this.options.modelId ?? "eleven_multilingual_v2",
          ...(input.language ? { language_code: input.language.split("-")[0] } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).split(apiKey).join("[REDACTED]");
      throw new Error(
        `ElevenLabs seslendirme hatası (HTTP ${res.status}): ${errText.slice(0, 240)}`,
      );
    }
    const body = (await res.json()) as {
      audio_base64?: string;
      alignment?: ElevenLabsAlignment;
      normalized_alignment?: ElevenLabsAlignment;
    };
    if (!body.audio_base64) throw new Error("ElevenLabs yanıtında ses yok (audio_base64).");
    const audioPath = path.join(input.workDir, "voice.mp3");
    await writeFile(audioPath, Buffer.from(body.audio_base64, "base64"));
    const est = Math.max(2000, input.text.trim().split(/\s+/).length * 420);
    const { words, durationMs } = wordsFromCharacterAlignment(
      body.alignment ?? body.normalized_alignment,
      input.text,
      est,
    );
    return { audioPath, durationMs, words, provider: this.name };
  }
}

export type SayCommandRunner = (
  bin: string,
  args: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export class MacSayTtsProvider implements TtsProvider {
  readonly name = "mac-say";
  private readonly sayBin: string;
  private readonly exec: SayCommandRunner;

  constructor(
    private readonly options: {
      ffmpeg: FfmpegRunner;
      sayBin?: string;
      voice?: string;
      exec?: SayCommandRunner;
    },
  ) {
    this.sayBin = options.sayBin ?? "/usr/bin/say";
    this.exec =
      options.exec ??
      (async (bin, args, opts) => {
        const r = await execFileAsync(bin, [...args], {
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        return { stdout: String(r.stdout), stderr: String(r.stderr) };
      });
  }

  private async say(
    text: string,
    out: string,
    voice: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const run = (v?: string) =>
      this.exec(this.sayBin, [...(v ? ["-v", v] : []), "-o", out, text], signal ? { signal } : {});
    try {
      await run(voice);
      return voice;
    } catch (error) {
      signal?.throwIfAborted();
      if (!voice) throw error;
      await run(undefined); // the Turkish voice is not installed: system voice
      return undefined;
    }
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const signal = input.signal;
    const wanted =
      input.voice ??
      this.options.voice ??
      (input.language === undefined || input.language.startsWith("tr") ? "Yelda" : undefined);
    const aiff = path.join(input.workDir, "voice.aiff");
    const voice = await this.say(input.text, aiff, wanted, signal);
    const audioPath = path.join(input.workDir, "voice.m4a");
    await transcodeAudioToAac({
      ffmpeg: this.options.ffmpeg,
      inPath: aiff,
      outPath: audioPath,
      ...(signal ? { signal } : {}),
    });
    const probe = await probeMedia(this.options.ffmpeg, audioPath, signal);
    const totalMs = probe.durationMs ?? Math.max(2000, input.text.trim().split(/\s+/).length * 430);

    // Measure each sentence alone, scale to the full take: captions follow the real rhythm.
    const sentences = splitSentences(input.text);
    let words: WordTimestamp[];
    if (sentences.length > 1) {
      const lengths: number[] = [];
      for (const [i, sentence] of sentences.entries()) {
        const part = path.join(input.workDir, `sentence-${i}.aiff`);
        await this.say(sentence, part, voice, signal);
        lengths.push((await probeMedia(this.options.ffmpeg, part, signal)).durationMs ?? 0);
      }
      const sum = lengths.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        const scale = totalMs / sum;
        words = [];
        let cursor = 0;
        for (const [i, sentence] of sentences.entries()) {
          const len = (lengths[i] ?? 0) * scale;
          words.push(...estimateWordTimestamps(sentence, len, Math.round(cursor)));
          cursor += len;
        }
      } else {
        words = estimateWordTimestamps(input.text, totalMs);
      }
    } else {
      words = estimateWordTimestamps(input.text, totalMs);
    }
    return {
      audioPath,
      durationMs: totalMs,
      words,
      provider: `${this.name}${voice ? `:${voice}` : ""}`,
    };
  }
}

export function selectTtsProvider(options: {
  elevenLabsApiKey?: string | undefined;
  elevenLabsVoiceId?: string | undefined;
  ffmpeg: FfmpegRunner;
  fetch?: typeof globalThis.fetch;
  sayExec?: SayCommandRunner;
}): TtsProvider | null {
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
  return null;
}
