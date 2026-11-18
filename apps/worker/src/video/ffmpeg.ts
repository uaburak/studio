/**
 * FFmpeg discovery, an injectable runner, and the Instagram Reels encoder
 * (`spikes/video-bakeoff/REPORT.md`, `tools/normalize.sh`, 15/15 conformance checks).
 */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Encoded video size budget: the API stores video assets up to 50 MiB. */
export const REEL_MAX_FILE_BYTES = 44 * 1024 * 1024;
export const REEL_AUDIO_BITRATE = 128_000;

/** Video bitrate for a reel: 8 Mb/s (bake-off) unless that would exceed the asset size budget. */
export function reelVideoBitrate(durationMs: number): number {
  const seconds = Math.max(1, durationMs / 1000);
  const budget = Math.floor((REEL_MAX_FILE_BYTES * 8) / seconds) - REEL_AUDIO_BITRATE;
  return Math.max(2_500_000, Math.min(8_000_000, Math.floor(budget / 100_000) * 100_000));
}

/**
 * x264 flags verified in the bake-off (15/15 Reels checks):
 * - `-threads 1` keeps the ABR/VBV output byte-stable run to run;
 * - fixed 2 s GOP (`-g 60 -keyint_min 60 -sc_threshold 0`), closed (`+cgop`);
 * - H.264 High, yuv420p, limited-range bt709 tags.
 */
export function reelsVideoArgs(durationMs = 8_000): string[] {
  const rate = reelVideoBitrate(durationMs);
  return [
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-flags",
    "+cgop",
    "-b:v",
    String(rate),
    "-maxrate",
    String(Math.round(rate * 1.5)),
    "-bufsize",
    String(rate * 2),
    "-color_range",
    "tv",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
  ];
}

/** The bake-off's 8 s encoder flags (kept for tests and callers that want the constant). */
export const REELS_FFMPEG_VIDEO_ARGS = reelsVideoArgs(8_000);

export const REELS_FFMPEG_AUDIO_ARGS = [
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-ar",
  "48000",
  "-ac",
  "2",
] as const;

/** `+negative_cts_offsets` + no edit list: video starts at pts 0 without a 2-frame delay. */
export const REELS_FFMPEG_CONTAINER_ARGS = [
  "-movflags",
  "+faststart+negative_cts_offsets",
  "-use_editlist",
  "0",
] as const;

export interface FfmpegRunOptions {
  stdin?: Uint8Array | AsyncIterable<Uint8Array> | readonly Uint8Array[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Accept these non-zero exit codes (probing with `-i` alone exits 1). */
  allowExitCodes?: readonly number[];
}

export interface FfmpegRunResult {
  stdout: Uint8Array;
  stderr: string;
}

export type FfmpegRunner = (
  args: readonly string[],
  options?: FfmpegRunOptions,
) => Promise<FfmpegRunResult>;

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Folders searched after `PATH` (Finder-launched apps get a short PATH). */
export function extraToolDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".studio", "bin"),
  ];
}

/** First executable `name` in `PATH` + the usual tool folders. */
export function findExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extraToolDirs(env)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The repo's pinned `ffmpeg-static` 6.0 (installed by the video bake-off, `spikes/video-bakeoff/tools`),
 * found by walking up from this file. Only a development fallback: the Mac host runs the worker
 * from the repo, so it is there when nothing else is.
 */
function repoFfmpeg(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(
        dir,
        "spikes/video-bakeoff/tools/node_modules/ffmpeg-static/ffmpeg",
      );
      if (isExecutable(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // bundled without a file URL
  }
  return null;
}

/**
 * Locate `ffmpeg`: `STUDIO_FFMPEG_BIN`, then `PATH` (the Mac host passes the login shell's PATH),
 * Homebrew and `~/.studio/bin`, then the repo's pinned `ffmpeg-static`.
 */
export function resolveFfmpegBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STUDIO_FFMPEG_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : null;
  return findExecutable(["ffmpeg"], env) ?? repoFfmpeg();
}

/** Turkish error when ffmpeg cannot be found. */
export const FFMPEG_MISSING_MESSAGE =
  "Reels için ffmpeg bulunamadı. Terminalde `brew install ffmpeg` ile kurun (Homebrew yoksa önce https://brew.sh) ya da STUDIO_FFMPEG_BIN ile ffmpeg'in yolunu verin; sonra Studio'yu yeniden başlatın.";

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Variables a media tool (ffmpeg, whisper.cpp, `say`) may see; never Studio's keys or tokens. */
const TOOL_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "FONTCONFIG_FILE",
  "FONTCONFIG_PATH",
] as const;

/**
 * Allow-listed environment for media child processes. They used to inherit the worker's whole
 * `process.env` (worker token, Gemini / ElevenLabs keys, the cloud token).
 */
export function buildToolEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of TOOL_ENV_ALLOW) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  // whisper.cpp / ggml tuning knobs (Metal resources, thread counts): no secrets.
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith("GGML_") && value) env[key] = value;
  }
  env.LANG ??= "en_US.UTF-8";
  return env;
}

export function createNodeFfmpegRunner(
  bin: string,
  env: Record<string, string> = buildToolEnv(),
): FfmpegRunner {
  return async (args, options = {}) => {
    options.signal?.throwIfAborted();
    return new Promise<FfmpegRunResult>((resolve, reject) => {
      const child = spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      let settled = false;

      const finish = (err?: Error, res?: FfmpegRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else if (res) resolve(res);
      };

      const onAbort = () => {
        child.kill("SIGKILL");
        finish(options.signal?.reason instanceof Error ? options.signal.reason : abortError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutMs = options.timeoutMs ?? 15 * 60_000;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new FfmpegError(`ffmpeg ${Math.round(timeoutMs / 1000)} sn içinde bitmedi.`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        // Keep the tail only (progress spam on long encodes).
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
        while (stderrBytes > 256 * 1024 && stderrChunks.length > 1) {
          stderrBytes -= stderrChunks.shift()?.byteLength ?? 0;
        }
      });
      child.on("error", (err) =>
        finish(new FfmpegError(`ffmpeg çalıştırılamadı (${bin}): ${err.message}`)),
      );
      child.stdin.on("error", () => {
        // EPIPE when ffmpeg exits early; the close handler reports stderr.
      });
      child.on("close", (code) => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0 && !(code !== null && options.allowExitCodes?.includes(code))) {
          finish(
            new FfmpegError(
              `ffmpeg başarısız oldu (çıkış ${code}): ${stderr.slice(-600).trim()}`,
              stderr,
            ),
          );
          return;
        }
        const out = Buffer.concat(stdoutChunks);
        finish(undefined, {
          stdout: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
          stderr,
        });
      });

      void (async () => {
        try {
          const input = options.stdin;
          if (!input) {
            child.stdin.end();
            return;
          }
          if (input instanceof Uint8Array) {
            child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
            return;
          }
          for await (const frame of input as AsyncIterable<Uint8Array>) {
            if (settled) return;
            options.signal?.throwIfAborted();
            const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
            if (!child.stdin.write(buf)) {
              await new Promise<void>((r) => {
                const done = () => {
                  child.stdin.off("drain", done);
                  child.off("close", done);
                  r();
                };
                child.stdin.once("drain", done);
                child.once("close", done);
              });
            }
          }
          child.stdin.end();
        } catch (err) {
          child.kill("SIGKILL");
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  };
}

function abortError(): Error {
  const e = new Error("İş iptal edildi");
  e.name = "AbortError";
  return e;
}

/** Duration and streams of a media file, read from `ffmpeg -i` (no ffprobe needed). */
export interface MediaProbe {
  durationMs: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export function parseFfmpegProbe(stderr: string): MediaProbe {
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const durationMs = d
    ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000)
    : null;
  const video = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    durationMs,
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
    hasVideo: /Stream #[^\n]*Video:/.test(stderr),
    width: video ? Number(video[1]) : null,
    height: video ? Number(video[2]) : null,
  };
}

export async function probeMedia(
  ffmpeg: FfmpegRunner,
  file: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  const res = await ffmpeg(["-hide_banner", "-i", file], {
    allowExitCodes: [1],
    ...(signal ? { signal } : {}),
  });
  return parseFfmpegProbe(res.stderr);
}

export interface ReelEncodeOptions {
  /** Rendered frames (JPEG or PNG with alpha when overlaying footage), streamed to stdin. */
  frames: AsyncIterable<Uint8Array> | readonly Uint8Array[];
  frameFormat: "jpeg" | "png";
  durationMs: number;
  outPath: string;
  /** Footage under the frames (`footage_edit`): scaled to fill 1080×1920. */
  clip?: { path: string; startMs: number; loop: boolean } | null;
  /** Main audio (voice-over, music, or the clip's own track when `fromClip`). */
  audio?: { path: string } | { fromClip: true } | null;
  /** Quiet music bed under the main audio. */
  music?: { path: string; volume: number } | null;
  ffmpeg: FfmpegRunner;
  signal?: AbortSignal;
}

/** Arguments of the single encode pass (exported for tests). */
export function buildReelEncodeArgs(
  options: Omit<ReelEncodeOptions, "frames" | "ffmpeg">,
): string[] {
  const seconds = (Math.max(500, options.durationMs) / 1000).toFixed(3);
  const args: string[] = ["-hide_banner", "-v", "error", "-y"];
  const inputs: string[] = [];
  let index = 0;
  const frameCodec = options.frameFormat === "png" ? "png" : "mjpeg";
  args.push("-f", "image2pipe", "-c:v", frameCodec, "-framerate", "30", "-i", "pipe:0");
  inputs.push("frames");
  const framesIdx = index++;
  let clipIdx = -1;
  if (options.clip) {
    if (options.clip.loop) args.push("-stream_loop", "-1");
    if (options.clip.startMs > 0) args.push("-ss", (options.clip.startMs / 1000).toFixed(3));
    args.push("-i", options.clip.path);
    clipIdx = index++;
  }
  let audioIdx = -1;
  let audioFromClip = false;
  if (options.audio && "path" in options.audio) {
    args.push("-i", options.audio.path);
    audioIdx = index++;
  } else if (options.audio && "fromClip" in options.audio && clipIdx >= 0) {
    audioFromClip = true;
  }
  let musicIdx = -1;
  if (options.music) {
    args.push("-stream_loop", "-1", "-i", options.music.path);
    musicIdx = index++;
  }
  args.push("-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo");
  const silenceIdx = index++;

  const filters: string[] = [];
  if (clipIdx >= 0) {
    filters.push(
      `[${clipIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[bg]`,
      `[bg][${framesIdx}:v]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[vout]`,
    );
  } else {
    filters.push(`[${framesIdx}:v]fps=30,format=yuv420p[vout]`);
  }
  const main =
    audioIdx >= 0 ? `[${audioIdx}:a]` : audioFromClip ? `[${clipIdx}:a]` : `[${silenceIdx}:a]`;
  const norm = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  if (musicIdx >= 0 && options.music) {
    filters.push(
      `${main}${norm}[a0]`,
      `[${musicIdx}:a]${norm},volume=${options.music.volume.toFixed(2)}[a1]`,
      "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amix]",
      `[amix][${silenceIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
  } else {
    // Mixing with the silent track pads short audio to the full length.
    filters.push(
      `${main}${norm}[a0]`,
      `[a0][${silenceIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    seconds,
    ...reelsVideoArgs(options.durationMs),
    ...REELS_FFMPEG_AUDIO_ARGS,
    ...REELS_FFMPEG_CONTAINER_ARGS,
    options.outPath,
  );
  return args;
}

/** Encode frames (+ footage, + audio) into a Reels-conformant MP4 at `outPath`. */
export async function encodeReel(options: ReelEncodeOptions): Promise<void> {
  const { frames, ffmpeg, signal, ...rest } = options;
  await ffmpeg(buildReelEncodeArgs(rest), {
    stdin: frames,
    ...(signal ? { signal } : {}),
  });
}

/** One JPEG frame of an encoded video (the cover image). */
export async function extractFrameJpeg(options: {
  ffmpeg: FfmpegRunner;
  videoPath: string;
  atMs: number;
  outPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  await options.ffmpeg(
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-ss",
      (Math.max(0, options.atMs) / 1000).toFixed(3),
      "-i",
      options.videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      options.outPath,
    ],
    options.signal ? { signal: options.signal } : {},
  );
}

/** Convert any audio file to 48 kHz stereo AAC (`.m4a`). */
export async function transcodeAudioToAac(options: {
  ffmpeg: FfmpegRunner;
  inPath: string;
  outPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  await options.ffmpeg(
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      options.inPath,
      "-vn",
      ...REELS_FFMPEG_AUDIO_ARGS,
      options.outPath,
    ],
    options.signal ? { signal: options.signal } : {},
  );
}

/** 16 kHz mono WAV for speech recognition (whisper.cpp only reads WAV reliably). */
export async function extractSpeechWav(options: {
  ffmpeg: FfmpegRunner;
  inPath: string;
  outPath: string;
  startMs?: number;
  durationMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const args = ["-hide_banner", "-v", "error", "-y"];
  if (options.startMs) args.push("-ss", (options.startMs / 1000).toFixed(3));
  args.push("-i", options.inPath);
  if (options.durationMs) args.push("-t", (options.durationMs / 1000).toFixed(3));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", options.outPath);
  await options.ffmpeg(args, options.signal ? { signal: options.signal } : {});
}
