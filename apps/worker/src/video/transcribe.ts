/**
 * Speech in a footage clip → word timings for burned-in captions (`footage_edit`).
 *
 * 1. whisper.cpp (`whisper-cli`, Homebrew `whisper-cpp`) with a local ggml model: the clip's audio
 *    is converted to 16 kHz WAV and transcribed word by word (`-ml 1 -sow -oj`).
 * 2. Otherwise Gemini (only when `GEMINI_API_KEY` is configured).
 * 3. Otherwise no transcript: the reel still renders, captions come from the plan, and the
 *    job says why (`TranscriptionResult.note`).
 */
import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants as fsConstants, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { callGeminiJson } from "../gemini/json-call.ts";
import type { GeminiUsageSample } from "../gemini/pricing.ts";
import { extractSpeechWav, type FfmpegRunner, findExecutable } from "./ffmpeg.ts";

const execFileAsync = promisify(nodeExecFile);

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptionResult {
  language: string;
  text: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
  provider: "whisper-cli" | "gemini" | "none";
  /** Turkish, why there is no transcript (provider `none`) or what went wrong. */
  note?: string;
}

export interface TranscribeClipInput {
  /** Media file on disk (any format ffmpeg reads). */
  path: string;
  mimeType: string;
  language?: string;
  /** Part of the clip used by the reel. */
  startMs?: number;
  durationMs?: number;
  signal?: AbortSignal;
}

export type ClipTranscriber = (input: TranscribeClipInput) => Promise<TranscriptionResult>;

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveWhisperBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STUDIO_WHISPER_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : null;
  return findExecutable(["whisper-cli", "whisper-cpp"], env);
}

/** A ggml model: `STUDIO_WHISPER_MODEL`, else the largest of base/small/medium in the usual folders. */
export function resolveWhisperModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STUDIO_WHISPER_MODEL?.trim();
  if (explicit) {
    try {
      accessSync(explicit, fsConstants.R_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  const home = env.HOME || homedir();
  const dirs = [
    path.join(home, ".studio", "models"),
    path.join(home, ".cache", "whisper"),
    "/opt/homebrew/share/whisper-cpp",
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp",
    "/usr/local/share/whisper-cpp/models",
  ];
  const preference = ["large-v3-turbo", "medium", "small", "base", "tiny"];
  const found: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (/^ggml-.*\.bin$/.test(name) && !name.includes(".en.")) found.push(path.join(dir, name));
      }
    } catch {
      // folder missing
    }
  }
  for (const want of preference) {
    const hit = found.find((f) => path.basename(f).startsWith(`ggml-${want}`));
    if (hit) return hit;
  }
  return found[0] ?? null;
}

export const WHISPER_MISSING_NOTE =
  "Klipteki konuşma yazıya dökülemedi: whisper.cpp kurulu değil. `brew install whisper-cpp` ile kurup bir model indirin (ör. ~/.studio/models/ggml-small.bin) ya da .env'e GEMINI_API_KEY ekleyin. Altyazılar senaryodaki metinlerden yazıldı.";

const GeminiTranscriptSchema = z.object({
  language: z.string().default("tr"),
  text: z.string().default(""),
  segments: z
    .array(
      z.object({
        text: z.string(),
        startMs: z.number().nonnegative(),
        endMs: z.number().nonnegative(),
      }),
    )
    .default([]),
});

interface WhisperJson {
  transcription?: {
    text?: string;
    offsets?: { from?: number; to?: number };
  }[];
}

/** whisper.cpp `-ml 1 -sow -oj` output → words (and sentence-ish segments). */
export function parseWhisperJson(
  raw: WhisperJson,
  offsetMs = 0,
): { words: TranscriptWord[]; segments: TranscriptSegment[] } {
  const words: TranscriptWord[] = [];
  for (const seg of raw.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue; // [Müzik], (alkış)
    const start = Math.max(0, Math.round(seg.offsets?.from ?? 0)) + offsetMs;
    const end = Math.max(start + 40, Math.round(seg.offsets?.to ?? 0) + offsetMs);
    for (const [i, part] of text.split(/\s+/).entries()) {
      // One segment is normally one word; split defensively and spread the time.
      const n = text.split(/\s+/).length;
      const s = start + Math.round(((end - start) * i) / n);
      const e = start + Math.round(((end - start) * (i + 1)) / n);
      words.push({ word: part.slice(0, 60), startMs: s, endMs: Math.max(s + 40, e) });
    }
  }
  return { words, segments: wordsToSegments(words) };
}

/** Group words into caption-sized segments (sentence end, pause or ~6 words). */
export function wordsToSegments(words: readonly TranscriptWord[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    out.push({
      text: current.map((w) => w.word).join(" "),
      startMs: current[0]?.startMs ?? 0,
      endMs: current.at(-1)?.endMs ?? 0,
    });
    current = [];
  };
  for (const w of words) {
    const prev = current.at(-1);
    if (prev && w.startMs - prev.endMs > 600) flush();
    current.push(w);
    if (/[.!?…]$/.test(w.word) || current.length >= 6) flush();
  }
  flush();
  return out;
}

/** Spread a segment's time over its words (Gemini returns segments only). */
export function segmentsToWords(segments: readonly TranscriptSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of segments) {
    const parts = seg.text.trim().split(/\s+/).filter(Boolean);
    const span = Math.max(parts.length * 80, seg.endMs - seg.startMs);
    const weights = parts.map((p) => Math.max(1, p.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = seg.startMs;
    for (const [i, word] of parts.entries()) {
      const dur = ((weights[i] ?? 1) / total) * span;
      words.push({
        word: word.slice(0, 60),
        startMs: Math.round(cursor),
        endMs: Math.round(cursor + dur),
      });
      cursor += dur;
    }
  }
  return words;
}

export interface DefaultTranscriberOptions {
  ffmpeg: FfmpegRunner;
  whisperBin?: string | null;
  whisperModel?: string | null;
  geminiApiKey?: string | undefined;
  geminiModelId?: string;
  fetch?: typeof globalThis.fetch;
  /** Gemini transcriptions report their tokens here (spend tracking). */
  onGeminiUsage?: ((sample: GeminiUsageSample) => void) | undefined;
  execWhisper?: (
    bin: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }>;
  env?: NodeJS.ProcessEnv;
}

export function createDefaultClipTranscriber(options: DefaultTranscriberOptions): ClipTranscriber {
  return async (input) => {
    const lang = input.language?.split("-")[0] ?? "tr";
    const env = options.env ?? process.env;
    const whisperBin = options.whisperBin ?? resolveWhisperBin(env);
    const whisperModel = options.whisperModel ?? resolveWhisperModel(env);
    let whisperFailure: string | null = null;

    if (whisperBin && whisperModel) {
      const workDir = await mkdtemp(path.join(tmpdir(), "studio-whisper-"));
      try {
        const wav = path.join(workDir, "speech.wav");
        await extractSpeechWav({
          ffmpeg: options.ffmpeg,
          inPath: input.path,
          outPath: wav,
          ...(input.startMs ? { startMs: input.startMs } : {}),
          ...(input.durationMs ? { durationMs: input.durationMs } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const outPrefix = path.join(workDir, "out");
        const execFn =
          options.execWhisper ??
          (async (bin, args, opts) => {
            const r = await execFileAsync(bin, [...args], {
              maxBuffer: 16 * 1024 * 1024,
              ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            return { stdout: String(r.stdout), stderr: String(r.stderr) };
          });
        await execFn(
          whisperBin,
          [
            "-m",
            whisperModel,
            "-f",
            wav,
            "-l",
            lang,
            "-ml",
            "1",
            "-sow",
            "-oj",
            "-of",
            outPrefix,
            "-np",
          ],
          input.signal ? { signal: input.signal } : undefined,
        );
        const raw = JSON.parse(await readFile(`${outPrefix}.json`, "utf8")) as WhisperJson;
        const { words, segments } = parseWhisperJson(raw);
        return {
          language: lang,
          text: words.map((w) => w.word).join(" "),
          segments,
          words,
          provider: "whisper-cli",
        };
      } catch (error) {
        input.signal?.throwIfAborted();
        whisperFailure = `whisper.cpp çalışmadı: ${(error as Error).message.slice(0, 200)}`;
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (options.geminiApiKey?.trim()) {
      const bytes = new Uint8Array(await readFile(input.path));
      const res = await callGeminiJson({
        onUsage: options.onGeminiUsage,
        apiKey: options.geminiApiKey,
        modelId: options.geminiModelId ?? "gemini-2.5-flash",
        system:
          "You are a precise Turkish audio/video transcriber. Transcribe spoken speech verbatim into short timestamped segments in milliseconds.",
        content: [
          {
            type: "text",
            text: `Transcribe this clip (expected language: ${lang}). Return JSON: { "language": "${lang}", "text": "...", "segments": [{ "text": "...", "startMs": 0, "endMs": 1800 }] }. If silent, return empty text and segments: [].`,
          },
          { type: "inline", mimeType: input.mimeType || "video/mp4", data: bytes },
        ],
        schema: {
          type: "object",
          required: ["language", "text", "segments"],
          properties: {
            language: { type: "string" },
            text: { type: "string" },
            segments: {
              type: "array",
              items: {
                type: "object",
                required: ["text", "startMs", "endMs"],
                properties: {
                  text: { type: "string" },
                  startMs: { type: "number" },
                  endMs: { type: "number" },
                },
              },
            },
          },
        },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const parsed = GeminiTranscriptSchema.parse(res.output);
      const start = input.startMs ?? 0;
      const end = start + (input.durationMs ?? Number.POSITIVE_INFINITY);
      const segments = parsed.segments
        .filter((s) => s.endMs > start && s.startMs < end)
        .map((s) => ({
          text: s.text,
          startMs: Math.max(0, s.startMs - start),
          endMs: Math.max(0, s.endMs - start),
        }));
      return {
        language: parsed.language || lang,
        text: parsed.text,
        segments,
        words: segmentsToWords(segments),
        provider: "gemini",
      };
    }

    return {
      language: lang,
      text: "",
      segments: [],
      words: [],
      provider: "none",
      note: whisperFailure
        ? `${whisperFailure}. Altyazılar senaryodaki metinlerden yazıldı.`
        : whisperBin && !whisperModel
          ? "Klipteki konuşma yazıya dökülemedi: whisper.cpp kurulu ama model dosyası yok. Bir ggml modelini ~/.studio/models/ altına koyun (ör. ggml-small.bin) ya da STUDIO_WHISPER_MODEL verin. Altyazılar senaryodaki metinlerden yazıldı."
          : WHISPER_MISSING_NOTE,
    };
  };
}
