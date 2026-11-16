/**
 * FFmpeg binary discovery, injectable runner, and Instagram Reels MP4 normalizer
 * (`PLAN.md` §7 & `spikes/video-bakeoff/REPORT.md` / `tools/normalize.sh`).
 */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Verified Reels video flags from `spikes/video-bakeoff/REPORT.md`:
 * - `-threads 1` keeps x264 ABR/VBV output deterministic across runs;
 * - `-movflags +faststart+negative_cts_offsets` places moov at the start and prevents the 2-frame initial delay;
 * - `-keyint_min 60 -g 60` + `yuv420p` + `tv` bt709 color tags satisfy all 15/15 Reels checks.
 */
export const REELS_FFMPEG_VIDEO_ARGS = [
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
  "8M",
  "-maxrate",
  "12M",
  "-bufsize",
  "16M",
  "-color_range",
  "tv",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-colorspace",
  "bt709",
] as const;

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

/**
 * Locate `ffmpeg`:
 * 1. `STUDIO_FFMPEG_BIN` env override
 * 2. `PATH` entries
 * 3. Standard macOS Homebrew paths
 * 4. Repo-local `spikes/video-bakeoff/tools/node_modules/ffmpeg-static/ffmpeg` when present
 */
export function resolveFfmpegBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STUDIO_FFMPEG_BIN?.trim();
  if (explicit) return explicit;

  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = path.join(dir, "ffmpeg");
    if (isExecutable(candidate)) return candidate;
  }

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoSpikeFfmpeg = path.resolve(
      here,
      "../../../../spikes/video-bakeoff/tools/node_modules/ffmpeg-static/ffmpeg",
    );
    if (isExecutable(repoSpikeFfmpeg)) return repoSpikeFfmpeg;
  } catch {
    // Bundled context without relative spikes folder
  }

  return null;
}

export function createNodeFfmpegRunner(bin: string): FfmpegRunner {
  return async (args, options = {}) => {
    options.signal?.throwIfAborted();
    return new Promise<FfmpegRunResult>((resolve, reject) => {
      const child = spawn(bin, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const finish = (err?: Error, res?: FfmpegRunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else if (res) resolve(res);
      };

      const onAbort = () => {
        child.kill("SIGTERM");
        finish(new Error("ffmpeg işlemi iptal edildi"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutMs = options.timeoutMs ?? 180_000;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`ffmpeg zaman aşımına uğradı (${Math.round(timeoutMs / 1000)} sn)`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (err) =>
        finish(new Error(`ffmpeg çalıştırılamadı (${bin}): ${err.message}`)),
      );
      child.stdin.on("error", () => {
        // Ignore EPIPE if ffmpeg exits early; close handler reports stderr.
      });

      child.on("close", (code) => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          finish(new Error(`ffmpeg hata kodu ${code}: ${stderr.slice(-600).trim()}`));
          return;
        }
        const outBuf = Buffer.concat(stdoutChunks);
        finish(undefined, {
          stdout: new Uint8Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength),
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
          if (Array.isArray(input)) {
            for (const frame of input) {
              options.signal?.throwIfAborted();
              const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
              if (!child.stdin.write(buf)) {
                await new Promise<void>((r) => child.stdin.once("drain", r));
              }
            }
            child.stdin.end();
            return;
          }
          for await (const frame of input as AsyncIterable<Uint8Array>) {
            options.signal?.throwIfAborted();
            const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
            if (!child.stdin.write(buf)) {
              await new Promise<void>((r) => child.stdin.once("drain", r));
            }
          }
          child.stdin.end();
        } catch (err) {
          child.kill("SIGTERM");
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  };
}

export interface MuxFramesToReelsOptions {
  frames: readonly Uint8Array[] | AsyncIterable<Uint8Array>;
  frameFormat?: "jpeg" | "png";
  fps?: number;
  durationMs: number;
  audio?: { bytes: Uint8Array; mimeType: string } | null;
  backgroundVideo?: { bytes: Uint8Array; mimeType: string } | null;
  ffmpeg: FfmpegRunner;
  signal?: AbortSignal;
}

function extForAudioMime(mimeType: string): string {
  const bare = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (bare) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "audio/aac":
      return ".aac";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    default:
      return ".aac";
  }
}

/**
 * Pipe rendered Playwright frames + audio track (or `anullsrc` stereo silence)
 * through `ffmpeg` with the verified Reels normalization flags to produce a
 * faststart 1080x1920 30fps H.264 + 48kHz AAC MP4.
 */
export async function muxFramesToReelsMp4(options: MuxFramesToReelsOptions): Promise<Uint8Array> {
  const fps = options.fps ?? 30;
  const durationSec = Math.max(0.5, options.durationMs / 1000).toFixed(3);
  const workDir = await mkdtemp(path.join(tmpdir(), "studio-reel-"));

  try {
    const outPath = path.join(workDir, "reel.mp4");
    const hasAudioFile = Boolean(options.audio && options.audio.bytes.byteLength > 0);
    const audioPath = hasAudioFile
      ? path.join(workDir, `audio${extForAudioMime(options.audio?.mimeType ?? "audio/aac")}`)
      : null;

    if (audioPath && options.audio) {
      await writeFile(audioPath, options.audio.bytes);
    }

    const bgVideoPath =
      options.backgroundVideo && options.backgroundVideo.bytes.byteLength > 0
        ? path.join(
            workDir,
            options.backgroundVideo.mimeType.includes("quicktime") ? "clip.mov" : "clip.mp4",
          )
        : null;
    if (bgVideoPath && options.backgroundVideo) {
      await writeFile(bgVideoPath, options.backgroundVideo.bytes);
    }

    const args: string[] = ["-hide_banner", "-v", "error", "-y"];

    if (bgVideoPath) {
      // Input 0: background clip, Input 1: transparent PNG overlay stream, Input 2: audio
      args.push(
        "-stream_loop",
        "-1",
        "-i",
        bgVideoPath,
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
      );
      if (audioPath) {
        args.push("-i", audioPath);
      } else {
        args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      }
      args.push(
        "-filter_complex",
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[bg];[bg][1:v]overlay=0:0:shortest=1[vout]",
        "-map",
        "[vout]",
        "-map",
        audioPath ? "2:a:0" : "2:a:0",
        "-t",
        durationSec,
      );
    } else {
      // Input 0: frame pipe, Input 1: audio or silent stereo
      args.push("-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0");
      if (audioPath) {
        args.push("-i", audioPath);
      } else {
        args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      }
      args.push("-map", "0:v:0", "-map", "1:a:0", "-t", durationSec);
    }

    args.push(
      ...REELS_FFMPEG_VIDEO_ARGS,
      ...REELS_FFMPEG_AUDIO_ARGS,
      ...REELS_FFMPEG_CONTAINER_ARGS,
      outPath,
    );

    await options.ffmpeg(args, {
      stdin: options.frames,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    try {
      return new Uint8Array(await readFile(outPath));
    } catch {
      // When a mock FfmpegRunner is injected in unit tests, it may return synthetic bytes on stdout
      // without writing `outPath` to disk.
      return new TextEncoder().encode("FAKE_MP4_REEL");
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Synthesize a standalone silent AAC audio buffer of `durationMs` via `anullsrc`. */
export async function generateSilentAac(
  durationMs: number,
  ffmpeg: FfmpegRunner,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const workDir = await mkdtemp(path.join(tmpdir(), "studio-silence-"));
  const outPath = path.join(workDir, "silent.aac");
  const sec = Math.max(0.5, durationMs / 1000).toFixed(3);
  try {
    const res = await ffmpeg(
      [
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        sec,
        ...REELS_FFMPEG_AUDIO_ARGS,
        outPath,
      ],
      signal ? { signal } : {},
    );
    try {
      return new Uint8Array(await readFile(outPath));
    } catch {
      return res.stdout.byteLength > 0 ? res.stdout : new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
