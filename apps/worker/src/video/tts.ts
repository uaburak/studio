/**
 * Voice-over for `narration` reels, with word timings for burned-in captions.
 * - `ElevenLabsTtsProvider`: `/v1/text-to-speech/{voiceId}/with-timestamps` (character alignment).
 *   Used only when `ELEVENLABS_API_KEY` is set (paid). The voice is `STUDIO_ELEVENLABS_VOICE_ID`,
 *   else a voice of the text's language from the account (`GET /v1/voices`, free); Turkish text
 *   without a Turkish voice fails with a clear message instead of an English voice.
 * - `MacSayTtsProvider`: offline macOS `say` (Turkish: "Yelda" or another installed `tr_TR`
 *   voice, checked with `say -v ?`; none installed fails with how to add one); every sentence is
 *   also measured on its own so the captions follow the real sentence rhythm, words inside a
 *   sentence are spread by Turkish syllable weight.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Logger, silentLogger } from "../log.ts";
import { buildToolEnv, type FfmpegRunner, probeMedia, transcodeAudioToAac } from "./ffmpeg.ts";

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
  /** Paid synthesis (ElevenLabs): the model used and the characters sent (spend). */
  billing?: { model: string; characters: number };
  /** Something the owner should know (Turkish), e.g. the asked voice was not installed. */
  note?: string;
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

/** No language means Turkish (Studio's default), like the brand default. */
function languageCode(language: string | undefined): string {
  return (language ?? "tr").trim().toLowerCase().split(/[-_]/)[0] || "tr";
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

export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";

export const ELEVENLABS_NO_TURKISH_VOICE =
  "ElevenLabs hesabında Türkçe ses yok: hesaptaki seslerin hiçbiri Türkçe olarak işaretli değil. ElevenLabs Voice Library'den bir Türkçe ses ekleyin ya da STUDIO_ELEVENLABS_VOICE_ID ayarlayın.";

/** `GET /v1/voices` entry (only the fields the language match reads). */
export interface ElevenLabsVoice {
  voice_id?: string;
  name?: string;
  labels?: Record<string, string | null | undefined> | null;
  verified_languages?:
    | { language?: string | null; locale?: string | null; accent?: string | null }[]
    | null;
  fine_tuning?: { language?: string | null } | null;
}

/** Language names that may appear in labels/accents instead of the ISO code. */
const LANGUAGE_NAMES: Record<string, readonly string[]> = {
  tr: ["turk", "türk"],
  en: ["english"],
};

function namesLanguage(value: string | null | undefined, lang: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (v === lang || v.startsWith(`${lang}-`) || v.startsWith(`${lang}_`)) return true;
  return (LANGUAGE_NAMES[lang] ?? []).some((name) => v.includes(name));
}

/**
 * How surely a voice speaks `lang`: 3 its own language (`labels.language`,
 * `fine_tuning.language`), 2 its accent label, 1 verified for it (`verified_languages`), 0 no.
 */
export function elevenLabsVoiceLanguageScore(voice: ElevenLabsVoice, lang: string): number {
  if (
    namesLanguage(voice.labels?.language, lang) ||
    namesLanguage(voice.fine_tuning?.language, lang)
  )
    return 3;
  const accent = voice.labels?.accent?.toLowerCase() ?? "";
  if ((LANGUAGE_NAMES[lang] ?? []).some((name) => accent.includes(name))) return 2;
  if (
    voice.verified_languages?.some(
      (l) => namesLanguage(l.language, lang) || namesLanguage(l.locale, lang),
    )
  )
    return 1;
  return 0;
}

/** Account voice per (key, language), so each reel does not list the voices again. */
const accountVoices = new Map<string, { voiceId: string; expiresAt: number }>();
const ACCOUNT_VOICE_TTL_MS = 60 * 60 * 1000;

/** Tests: forget the account voices found so far. */
export function clearElevenLabsVoiceCache(): void {
  accountVoices.clear();
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  private readonly doFetch: typeof globalThis.fetch;
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      apiKey: string;
      defaultVoiceId?: string | undefined;
      modelId?: string;
      fetch?: typeof globalThis.fetch;
      logger?: Logger;
    },
  ) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger ?? silentLogger;
  }

  private redact(text: string): string {
    return text.split(this.options.apiKey.trim()).join("[REDACTED]");
  }

  /** A voice of `lang` from the account (`GET /v1/voices`, free); never a made-up id. */
  private async accountVoice(
    lang: string,
    signal: AbortSignal | undefined,
  ): Promise<{ voiceId: string; cacheKey: string }> {
    const apiKey = this.options.apiKey.trim();
    const cacheKey = `${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}:${lang}`;
    const hit = accountVoices.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return { voiceId: hit.voiceId, cacheKey };
    const res = await this.doFetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey, accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const errText = this.redact(await res.text().catch(() => ""));
      throw new Error(
        `ElevenLabs ses listesi okunamadı (HTTP ${res.status}): ${errText.slice(0, 240)}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { voices?: ElevenLabsVoice[] };
    const voices = (body.voices ?? []).filter(
      (v): v is ElevenLabsVoice & { voice_id: string } =>
        typeof v.voice_id === "string" && v.voice_id.length > 0,
    );
    let best: (ElevenLabsVoice & { voice_id: string }) | undefined;
    let bestScore = 0;
    for (const voice of voices) {
      const score = elevenLabsVoiceLanguageScore(voice, lang);
      if (score > bestScore) {
        best = voice;
        bestScore = score;
      }
    }
    if (!best) {
      if (lang === "tr") throw new Error(ELEVENLABS_NO_TURKISH_VOICE);
      // Other languages: any account voice (the multilingual model speaks them all).
      best = voices[0];
      if (!best) {
        throw new Error(
          "ElevenLabs hesabında hiç ses yok: Voice Library'den bir ses ekleyin ya da STUDIO_ELEVENLABS_VOICE_ID ayarlayın.",
        );
      }
    }
    this.logger.info(`elevenlabs: voice "${best.name ?? best.voice_id}" chosen for ${lang}`);
    accountVoices.set(cacheKey, {
      voiceId: best.voice_id,
      expiresAt: Date.now() + ACCOUNT_VOICE_TTL_MS,
    });
    return { voiceId: best.voice_id, cacheKey };
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const apiKey = this.options.apiKey.trim();
    const modelId = this.options.modelId ?? ELEVENLABS_DEFAULT_MODEL;
    const configured = input.voice ?? this.options.defaultVoiceId;
    const found = configured
      ? undefined
      : await this.accountVoice(languageCode(input.language), input.signal);
    const voiceId = configured ?? found?.voiceId ?? "";
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
          model_id: modelId,
          ...(input.language ? { language_code: input.language.split("-")[0] } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (!res.ok) {
      // A voice found in the account may have been removed since: look it up again next time.
      if (found) accountVoices.delete(found.cacheKey);
      const errText = this.redact(await res.text().catch(() => ""));
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
    return {
      audioPath,
      durationMs,
      words,
      provider: this.name,
      // ElevenLabs bills the characters of the text sent.
      billing: { model: modelId, characters: [...input.text].length },
    };
  }
}

export type SayCommandRunner = (
  bin: string,
  args: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export const MAC_TURKISH_VOICE_MISSING =
  "Türkçe seslendirme için bu Mac'te Türkçe bir sistem sesi yüklü değil. Sistem Ayarları → Erişilebilirlik → Sesli İçerik → Sistem sesi → Ses Yönet… → Türkçe bölümünden bir ses (ör. Yelda) indirip yeniden deneyin; ya da ELEVENLABS_API_KEY tanımlayın.";

export interface SystemVoice {
  name: string;
  /** `tr_TR`, `en_US`, … */
  locale: string;
}

/** `say -v ?` lines: `Yelda (Enhanced)    tr_TR    # Merhaba, benim adım Yelda.` */
export function parseSayVoices(stdout: string): SystemVoice[] {
  const voices: SystemVoice[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line.trim());
    if (m?.[1] && m[2]) voices.push({ name: m[1].trim(), locale: m[2].replace("-", "_") });
  }
  return voices;
}

/** Name without the quality tag: "Yelda (Enhanced)" → "yelda". */
const baseVoiceName = (name: string) =>
  name
    .replace(/\s*\((?:enhanced|premium|compact)\)\s*$/i, "")
    .trim()
    .toLowerCase();

/** An installed voice by name ("Yelda" also finds "Yelda (Premium)"), best quality first. */
function findSystemVoice(voices: readonly SystemVoice[], wanted: string): SystemVoice | undefined {
  const exact = voices.find((v) => v.name.toLowerCase() === wanted.trim().toLowerCase());
  if (exact) return exact;
  const base = baseVoiceName(wanted);
  const quality = (v: SystemVoice) =>
    /\(premium\)/i.test(v.name) ? 0 : /\(enhanced\)/i.test(v.name) ? 1 : 2;
  return voices
    .filter((v) => baseVoiceName(v.name) === base)
    .sort((a, b) => quality(a) - quality(b))[0];
}

export class MacSayTtsProvider implements TtsProvider {
  readonly name = "mac-say";
  private readonly sayBin: string;
  private readonly exec: SayCommandRunner;
  private readonly logger: Logger;
  private voices: Promise<SystemVoice[] | null> | undefined;

  constructor(
    private readonly options: {
      ffmpeg: FfmpegRunner;
      sayBin?: string;
      voice?: string;
      exec?: SayCommandRunner;
      logger?: Logger;
    },
  ) {
    this.sayBin = options.sayBin ?? "/usr/bin/say";
    this.logger = options.logger ?? silentLogger;
    this.exec =
      options.exec ??
      (async (bin, args, opts) => {
        const r = await execFileAsync(bin, [...args], {
          env: buildToolEnv(),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        return { stdout: String(r.stdout), stderr: String(r.stderr) };
      });
  }

  /** Installed voices (`say -v ?`, once per provider); null when they cannot be listed. */
  private systemVoices(signal?: AbortSignal): Promise<SystemVoice[] | null> {
    this.voices ??= this.exec(this.sayBin, ["-v", "?"], signal ? { signal } : {}).then(
      (r) => {
        const list = parseSayVoices(r.stdout);
        return list.length > 0 ? list : null;
      },
      (error: unknown) => {
        this.logger.warn(`say: voices not listed (${(error as Error).message})`);
        return null;
      },
    );
    return this.voices;
  }

  /**
   * The voice to use: the asked one when installed; for Turkish text "Yelda" or another
   * installed Turkish voice (none: a clear error, never an English voice); other text the asked
   * voice or the system voice.
   */
  private async chooseVoice(
    wanted: string | undefined,
    turkish: boolean,
    signal?: AbortSignal,
  ): Promise<{ voice: string | undefined; verified: boolean; note?: string }> {
    const voices = await this.systemVoices(signal);
    signal?.throwIfAborted();
    const asked = wanted ?? (turkish ? "Yelda" : undefined);
    if (!voices) return { voice: asked, verified: false };
    const installed = asked ? findSystemVoice(voices, asked) : undefined;
    if (installed) return { voice: installed.name, verified: true };
    if (turkish) {
      const tr = voices.filter((v) => v.locale.toLowerCase().startsWith("tr"));
      const pick = findSystemVoice(tr, "Yelda") ?? tr[0];
      if (!pick) throw new Error(MAC_TURKISH_VOICE_MISSING);
      if (wanted || !/^yelda/i.test(pick.name)) {
        this.logger.warn(`say: voice "${asked}" is not installed; using ${pick.name}`);
      }
      return {
        voice: pick.name,
        verified: true,
        ...(wanted
          ? { note: `“${wanted}” sesi bu Mac'te yüklü değil; ${pick.name} kullanıldı.` }
          : {}),
      };
    }
    if (!asked) return { voice: undefined, verified: true };
    this.logger.warn(`say: voice "${asked}" is not installed; using the system voice`);
    return {
      voice: undefined,
      verified: true,
      note: `“${asked}” sesi bu Mac'te yüklü değil; sistem sesi kullanıldı.`,
    };
  }

  private run(text: string, out: string, voice: string | undefined, signal?: AbortSignal) {
    return this.exec(
      this.sayBin,
      [...(voice ? ["-v", voice] : []), "-o", out, text],
      signal ? { signal } : {},
    );
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesisResult> {
    const signal = input.signal;
    const turkish = languageCode(input.language) === "tr";
    const choice = await this.chooseVoice(input.voice ?? this.options.voice, turkish, signal);
    const aiff = path.join(input.workDir, "voice.aiff");
    let voice = choice.voice;
    let note = choice.note;
    try {
      await this.run(input.text, aiff, voice, signal);
    } catch (error) {
      signal?.throwIfAborted();
      // Voices could not be listed: a failing voice is most likely not installed.
      if (choice.verified || !voice) throw error;
      if (turkish) throw new Error(`${MAC_TURKISH_VOICE_MISSING} (${(error as Error).message})`);
      this.logger.warn(`say: voice "${voice}" failed; using the system voice`);
      note = `“${voice}” sesi bu Mac'te yüklü değil; sistem sesi kullanıldı.`;
      voice = undefined;
      await this.run(input.text, aiff, undefined, signal);
    }
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
        await this.run(sentence, part, voice, signal);
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
      ...(note ? { note } : {}),
    };
  }
}

export function selectTtsProvider(options: {
  elevenLabsApiKey?: string | undefined;
  elevenLabsVoiceId?: string | undefined;
  ffmpeg: FfmpegRunner;
  fetch?: typeof globalThis.fetch;
  sayExec?: SayCommandRunner;
  logger?: Logger;
}): TtsProvider | null {
  if (options.elevenLabsApiKey?.trim()) {
    return new ElevenLabsTtsProvider({
      apiKey: options.elevenLabsApiKey,
      ...(options.elevenLabsVoiceId ? { defaultVoiceId: options.elevenLabsVoiceId } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  if (process.platform === "darwin" || options.sayExec) {
    return new MacSayTtsProvider({
      ffmpeg: options.ffmpeg,
      ...(options.sayExec ? { exec: options.sayExec } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return null;
}
