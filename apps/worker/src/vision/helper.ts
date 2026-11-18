/**
 * The worker's side of `studio-vision` (apps/vision-helper): Apple's Vision framework on this Mac
 * (free, on-device, no network). One process per request: JSON on stdin, JSON on stdout.
 *
 * Where the binary is found, in order:
 * 1. `STUDIO_VISION_HELPER` (an explicit path);
 * 2. next to the bundled worker: `<host>/worker/main.js` → `<host>/bin/studio-vision`
 *    (Studio.app/Contents/Resources/host, staged by apps/desktop/scripts/build-host.mjs);
 * 3. the repo's build output: `apps/vision-helper/.build/release/studio-vision` (dev; build it with
 *    `swift build -c release --package-path apps/vision-helper`).
 * Missing → `available()` is false and the features that need it say so in Turkish (no crash).
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

export const VISION_HELPER_NAME = "studio-vision";

/** What a feature says when the helper is not there. */
export const VISION_HELPER_MISSING =
  "Görsel yardımcı aracı (studio-vision) bulunamadı. Geliştirmede `swift build -c release --package-path apps/vision-helper` ile derleyin; paketli uygulamada Studio'yu yeniden kurun.";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  /** Normalized, top-left origin. */
  box: Box;
}

export interface OcrResult {
  languages: string[];
  unsupportedLanguages: string[];
  lines: OcrLine[];
  text: string;
}

export interface ClassifyResult {
  labels: { identifier: string; confidence: number }[];
}

export interface FeaturePrintResult {
  revision: number;
  count: number;
  /** Little-endian Float32, base64. */
  data: string;
}

export interface MaskResult {
  instances: { instance: number; area: number }[];
  used: number[];
  box: Box;
  pixelBox: Box;
  coverage: number;
  width: number;
  height: number;
  output: string | null;
  png: string | null;
}

export interface SaliencyResult {
  objects: { box: Box; confidence: number }[];
  columns: number;
  rows: number;
  /** Row-major from the top-left, 0…1 (1 = the most attention-grabbing cell). */
  grid: number[];
}

export interface AnalyzeResult {
  classify?: ClassifyResult;
  ocr?: OcrResult;
  featurePrint?: FeaturePrintResult;
  saliency?: SaliencyResult;
  errors: Record<string, { code: string; message: string }>;
}

export interface VersionResult {
  helperVersion: string;
  os: string;
  ocrLanguages: string[];
  foregroundMask: boolean;
  featurePrintRevision: number;
}

export interface HelperResponse<T> {
  ok: boolean;
  command: string;
  helperVersion: string;
  image?: { width: number; height: number };
  result?: T;
  error?: { code: string; message: string };
  timingMs: number;
}

/** A failed helper run: `code` is the helper's (`no_foreground`, `unreadable_image` …) or ours. */
export class VisionHelperError extends Error {
  override name = "VisionHelperError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VisionHelper {
  /** The binary in use, or null. */
  readonly bin: string | null;
  /** True when the binary exists and answered `version` (cached; re-checked after a minute). */
  available(): Promise<boolean>;
  info(): Promise<VersionResult | null>;
  /** Run one request; resolves with the helper's answer (ok or not), rejects when it cannot run. */
  run<T>(request: Record<string, unknown>, options?: RunOptions): Promise<HelperResponse<T>>;
  ocr(file: string, options?: RunOptions & { languages?: string[] }): Promise<OcrResult>;
  classify(file: string, options?: RunOptions): Promise<ClassifyResult>;
  featurePrint(file: string, options?: RunOptions): Promise<FeaturePrintResult>;
  foregroundMask(
    file: string,
    output: string,
    options?: RunOptions & { instances?: "all" | "largest" },
  ): Promise<MaskResult>;
  saliency(
    file: string,
    options?: RunOptions & { columns?: number; rows?: number },
  ): Promise<SaliencyResult>;
  analyze(
    file: string,
    ops: ("classify" | "ocr" | "feature-print" | "saliency")[],
    options?: RunOptions,
  ): Promise<{ result: AnalyzeResult; helperVersion: string }>;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Default 120 s: Vision compiles its models on a binary's very first run (~30 s). */
  timeoutMs?: number;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `studio-vision` is (see the file header), or null. */
export function findVisionHelper(
  env: Record<string, string | undefined> = process.env,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  const explicit = env.STUDIO_VISION_HELPER?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : null;
  const candidates: string[] = [];
  // Bundled: <host>/worker/main.js → <host>/bin/studio-vision.
  candidates.push(path.resolve(moduleDir, "..", "bin", VISION_HELPER_NAME));
  // Repo: walk up to the folder that has apps/vision-helper.
  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    candidates.push(
      path.join(dir, "apps", "vision-helper", ".build", "release", VISION_HELPER_NAME),
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find(isExecutable) ?? null;
}

/** At most this many helper processes at once (Vision shares the Neural Engine / GPU). */
const MAX_PARALLEL = 2;
const RECHECK_MS = 60_000;

export interface VisionHelperOptions {
  bin: string | null;
  logger?: Logger;
  /** Test seam. */
  spawnFn?: typeof spawn;
}

export function createVisionHelper(options: VisionHelperOptions): VisionHelper {
  const logger = options.logger ?? silentLogger;
  const doSpawn = options.spawnFn ?? spawn;
  const bin = options.bin;
  let running = 0;
  const waiting: (() => void)[] = [];
  let checked: { at: number; info: VersionResult | null } | null = null;
  let checking: Promise<VersionResult | null> | null = null;

  const acquire = async () => {
    if (running < MAX_PARALLEL) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  async function run<T>(
    request: Record<string, unknown>,
    opts: RunOptions = {},
  ): Promise<HelperResponse<T>> {
    if (!bin) throw new VisionHelperError("missing", VISION_HELPER_MISSING);
    opts.signal?.throwIfAborted();
    await acquire();
    try {
      return await new Promise<HelperResponse<T>>((resolve, reject) => {
        const child = doSpawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new VisionHelperError(
                "timeout",
                "Görsel yardımcı aracı zamanında yanıt vermedi; yeniden denenecek.",
              ),
            ),
          );
        }, opts.timeoutMs ?? 120_000);
        const onAbort = () => {
          child.kill("SIGKILL");
          finish(() => reject(opts.signal?.reason ?? new Error("aborted")));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < 4000) stderr += chunk;
        });
        child.on("error", (error) =>
          finish(() =>
            reject(
              new VisionHelperError(
                "spawn_failed",
                `Görsel yardımcı aracı çalıştırılamadı: ${error.message}`,
              ),
            ),
          ),
        );
        child.on("close", (code, sig) => {
          finish(() => {
            const line = stdout.trim().split("\n").at(-1) ?? "";
            try {
              resolve(JSON.parse(line) as HelperResponse<T>);
            } catch {
              logger.warn(
                `studio-vision exited (${code ?? sig}) without JSON: ${stderr.trim().slice(0, 300)}`,
              );
              reject(
                new VisionHelperError(
                  "bad_output",
                  "Görsel yardımcı aracı beklenmedik biçimde kapandı.",
                ),
              );
            }
          });
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(JSON.stringify(request));
      });
    } finally {
      release();
    }
  }

  async function result<T>(
    request: Record<string, unknown>,
    opts: RunOptions | undefined,
  ): Promise<T & {}> {
    const res = await run<T>(request, opts);
    if (!res.ok || res.result === undefined || res.result === null) {
      throw new VisionHelperError(
        res.error?.code ?? "failed",
        res.error?.message ?? "Görsel yardımcı aracı sonuç döndürmedi.",
      );
    }
    return res.result as T & {};
  }

  async function info(): Promise<VersionResult | null> {
    if (!bin) return null;
    if (checked && (checked.info || Date.now() - checked.at < RECHECK_MS)) return checked.info;
    checking ??= (async () => {
      try {
        const res = await run<VersionResult>({ command: "version" }, { timeoutMs: 30_000 });
        const out = res.ok && res.result ? res.result : null;
        if (out) logger.info(`studio-vision ${out.helperVersion} ready (${bin})`);
        return out;
      } catch (error) {
        logger.warn(`studio-vision did not answer: ${(error as Error).message}`);
        return null;
      }
    })();
    try {
      const out = await checking;
      checked = { at: Date.now(), info: out };
      return out;
    } finally {
      checking = null;
    }
  }

  return {
    bin,
    available: async () => (await info()) !== null,
    info,
    run,
    ocr: (file, opts) =>
      result<OcrResult>(
        { command: "ocr", path: file, languages: opts?.languages ?? ["tr-TR", "en-US"] },
        opts,
      ),
    classify: (file, opts) => result<ClassifyResult>({ command: "classify", path: file }, opts),
    featurePrint: (file, opts) =>
      result<FeaturePrintResult>({ command: "feature-print", path: file }, opts),
    foregroundMask: (file, output, opts) =>
      result<MaskResult>(
        {
          command: "foreground-mask",
          path: file,
          output,
          instances: opts?.instances ?? "all",
          crop: true,
        },
        opts,
      ),
    saliency: (file, opts) =>
      result<SaliencyResult>(
        {
          command: "saliency",
          path: file,
          gridColumns: opts?.columns ?? 12,
          gridRows: opts?.rows ?? 12,
        },
        opts,
      ),
    analyze: async (file, ops, opts) => {
      const res = await run<AnalyzeResult>({ command: "analyze", path: file, ops }, opts);
      if (!res.ok || !res.result) {
        throw new VisionHelperError(
          res.error?.code ?? "failed",
          res.error?.message ?? "Görsel yardımcı aracı sonuç döndürmedi.",
        );
      }
      return { result: res.result, helperVersion: res.helperVersion };
    },
  };
}

/** A helper that is never there (tests, and workers started without one). */
export function missingVisionHelper(): VisionHelper {
  return createVisionHelper({ bin: null });
}
