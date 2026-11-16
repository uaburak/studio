/**
 * Clip transcription for the `footage_edit` Reels recipe (`PLAN.md` §7):
 * - Uses `whisper-cli` locally when available in PATH or `STUDIO_WHISPER_BIN`,
 * - Otherwise uses Gemini multimodal audio/video transcription (`GEMINI_API_KEY`),
 * - Falls back cleanly when neither is configured (and supports injected mock transcribers).
 */
import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { callGeminiJson } from "../gemini/json-call.ts";

const execFileAsync = promisify(nodeExecFile);

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptionResult {
  language: string;
  text: string;
  segments: TranscriptSegment[];
  provider: "whisper-cli" | "gemini" | "none";
}

export interface TranscribeClipInput {
  bytes: Uint8Array;
  mimeType: string;
  language?: string;
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
  if (explicit) return explicit;
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = path.join(dir, "whisper-cli");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

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

function parseTimestampMs(ts: string): number {
  const m = /(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(ts.trim());
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  return (h * 3600 + min * 60 + sec) * 1000 + ms;
}

export interface DefaultTranscriberOptions {
  whisperBin?: string | null;
  geminiApiKey?: string | undefined;
  geminiModelId?: string;
  fetch?: typeof globalThis.fetch;
  execWhisper?: (
    bin: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export function createDefaultClipTranscriber(
  options: DefaultTranscriberOptions = {},
): ClipTranscriber {
  return async (input) => {
    const lang = input.language?.split("-")[0] ?? "tr";
    const whisperBin = options.whisperBin ?? resolveWhisperBin();

    if (whisperBin) {
      const workDir = await mkdtemp(path.join(tmpdir(), "studio-whisper-"));
      try {
        const ext = input.mimeType.includes("wav") ? ".wav" : ".mp4";
        const inPath = path.join(workDir, `clip${ext}`);
        const outPrefix = path.join(workDir, "out");
        await writeFile(inPath, input.bytes);
        const execFn =
          options.execWhisper ??
          (async (bin, args, opts) => {
            const r = await execFileAsync(bin, [...args], {
              ...(opts?.signal ? { signal: opts.signal } : {}),
            });
            return { stdout: String(r.stdout), stderr: String(r.stderr) };
          });
        await execFn(
          whisperBin,
          ["-f", inPath, "-l", lang, "-oj", "-of", outPrefix],
          input.signal ? { signal: input.signal } : undefined,
        );
        const rawJson = JSON.parse(await readFile(`${outPrefix}.json`, "utf8")) as {
          transcription?: {
            text?: string;
            offsets?: { from?: number; to?: number };
            timestamps?: { from?: string; to?: string };
          }[];
        };
        const segments: TranscriptSegment[] = (rawJson.transcription ?? [])
          .map((seg) => {
            const startMs =
              seg.offsets?.from ??
              (seg.timestamps?.from ? parseTimestampMs(seg.timestamps.from) : 0);
            const endMs =
              seg.offsets?.to ??
              (seg.timestamps?.to ? parseTimestampMs(seg.timestamps.to) : startMs + 1000);
            return {
              text: (seg.text ?? "").trim(),
              startMs: Math.max(0, Math.round(startMs)),
              endMs: Math.max(Math.round(startMs) + 50, Math.round(endMs)),
            };
          })
          .filter((s) => s.text.length > 0);
        return {
          language: lang,
          text: segments.map((s) => s.text).join(" "),
          segments,
          provider: "whisper-cli",
        };
      } catch {
        // Fall through to Gemini multimodal transcription if whisper-cli fails (e.g. missing model file)
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (options.geminiApiKey?.trim()) {
      const res = await callGeminiJson({
        apiKey: options.geminiApiKey,
        modelId: options.geminiModelId ?? "gemini-2.5-flash",
        system:
          "You are a precise Turkish audio/video transcriber. Transcribe spoken speech verbatim into timestamped segments in milliseconds.",
        content: [
          {
            type: "text",
            text: `Transcribe this clip (expected language: ${lang}). Return JSON: { "language": "${lang}", "text": "...", "segments": [{ "text": "...", "startMs": 0, "endMs": 1800 }] }. If silent, return empty text and segments: [].`,
          },
          {
            type: "inline",
            mimeType: input.mimeType || "video/mp4",
            data: input.bytes,
          },
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
      return {
        language: parsed.language || lang,
        text: parsed.text,
        segments: parsed.segments,
        provider: "gemini",
      };
    }

    return {
      language: lang,
      text: "",
      segments: [],
      provider: "none",
    };
  };
}
