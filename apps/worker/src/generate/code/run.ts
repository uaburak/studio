/**
 * Running a code engine program and checking what it drew (docs/URETIM-RESIM.md, Faz 4): the
 * run's input folder (the brand's font files, the pictures, the filled slots), one sandbox run,
 * the output checks and the lint, storing a version whose slides show the renders and carry the
 * program; re-running a stored program with an approved picture in its slot (`content.render`).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Content, type ContentVersion, codeSlideSlots } from "@studio/contract";
import { colorValue } from "@studio/design-kit/brand";
import {
  type CarouselLintReport,
  findUnverifiedNumbers,
  type LintConfig,
  type LintReport,
  lintCarousel,
} from "@studio/design-kit/lint";
import { type AssetResolver, pngToSrgbJpeg } from "@studio/design-kit/render";
import sharp from "sharp";
import type { AgentDeps } from "../../agent.ts";
import type { SlideReport } from "../../checks/pipeline.ts";
import { extensionForMime } from "../../media.ts";
import { layoutFromReport } from "../../render/layout.ts";
import { type BrandContext, loadBrandContext } from "../brand.ts";
import type { EmptyImageSlot } from "../slot-images.ts";
import { precheckProgram } from "./check.ts";
import {
  type CodeInputs,
  type CodePicture,
  type CodeSlideRecord,
  codeRenderSrc,
  codeSlideHtml,
  parseRunRecord,
  readCodeRecord,
  readCodeSource,
} from "./document.ts";
import { inspectPng, lintCodeSlide } from "./lint.ts";
import type { CodeDesignOutput } from "./prompt.ts";
import { ensureCodeRuntime, runtimeRoot } from "./runtime.ts";
import { createJobDir, DEFAULT_TIMEOUT_MS, runInSandbox, type SandboxResult } from "./sandbox.ts";

/** Runs one program (the sandbox; a fake in tests). */
export interface CodeProgramRunner {
  run(req: {
    jobDir: string;
    program: string;
    input: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
    /** Called when the Python runtime is being set up first (the job waits). */
    onWait?: () => void;
  }): Promise<SandboxResult>;
}

/** The real runner: the Python runtime (built on first use) and the sandbox. */
export function sandboxRunner(stateDir: string, log?: (line: string) => void): CodeProgramRunner {
  return {
    async run(req) {
      const runtime = await ensureCodeRuntime(stateDir, {
        signal: req.signal,
        ...(req.onWait ? { onWait: req.onWait } : {}),
        ...(log ? { log } : {}),
      });
      return runInSandbox({
        runtime,
        jobDir: req.jobDir,
        program: req.program,
        input: req.input,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
    },
  };
}

/** What the engine needs of the worker (generation and render deps both have it). */
export interface CodeEngineDeps {
  api: AgentDeps["api"];
  settings: AgentDeps["settings"];
  logger: AgentDeps["logger"];
  stateDir: string;
  /** Test seam: the program runner (default: the sandbox). */
  codeRunner?: CodeProgramRunner;
}

function runnerOf(deps: CodeEngineDeps): CodeProgramRunner {
  return deps.codeRunner ?? sandboxRunner(deps.stateDir, (l) => deps.logger.info(`[code] ${l}`));
}

const MAX_PICTURES = 24;

export interface CheckedCodeSlide {
  id: string;
  n: number;
  png: Uint8Array | null;
  jpeg: Uint8Array | null;
  record: CodeSlideRecord | null;
  report: LintReport | null;
  failure: string | null;
}

export interface CheckedCodeVersion {
  label: string;
  output: CodeDesignOutput;
  slides: CheckedCodeSlide[];
  /** Why the run produced nothing usable (English: it goes back to the model). */
  runError: string | null;
  runStatus: SandboxResult["status"] | "precheck";
  carousel: CarouselLintReport | null;
  captionNumbers: string[];
  warnings: string[];
  errors: number;
  warningCount: number;
}

// --- the run's input folder --------------------------------------------------------------------

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "file";
}

async function pictureBytes(
  deps: CodeEngineDeps,
  brand: BrandContext,
  picture: CodePicture,
  signal: AbortSignal,
  cache: Map<string, { bytes: Uint8Array; ext: string } | null>,
): Promise<{ bytes: Uint8Array; ext: string } | null> {
  const key = "brandPath" in picture.source ? picture.source.brandPath : picture.source.assetId;
  if (cache.has(key)) return cache.get(key) ?? null;
  let out: { bytes: Uint8Array; ext: string } | null = null;
  try {
    if ("brandPath" in picture.source) {
      const res = await brand.resolver.resolve(picture.source.brandPath);
      if (res) out = { bytes: res.body, ext: path.extname(picture.source.brandPath) || ".png" };
    } else {
      const res = await deps.api.downloadAsset(picture.source.assetId, {
        maxBytes: Math.max(deps.settings.imageMaxBytes, 40 * 1024 * 1024),
        signal,
      });
      out = { bytes: res.bytes, ext: extensionForMime(res.contentType) || ".jpg" };
    }
  } catch (error) {
    signal.throwIfAborted();
    deps.logger.warn(`[code] picture ${picture.name} unavailable: ${(error as Error).message}`);
  }
  // Pillow does not read SVG: a vector logo is rasterised (2× its size, at most 2048 px).
  if (out && /\.svg$/i.test(out.ext)) {
    try {
      const png = await sharp(out.bytes, { density: 144 })
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      out = { bytes: new Uint8Array(png), ext: ".png" };
    } catch {
      out = null;
    }
  }
  cache.set(key, out);
  return out;
}

/**
 * Write the brand's font files, the pictures and the filled slots' pictures into the job's input
 * folder; the run's input JSON (studio_brand reads it).
 */
async function prepareRunInput(
  deps: CodeEngineDeps,
  brand: BrandContext,
  inputs: CodeInputs,
  jobDir: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const fontsDir = path.join(jobDir, "input", "fonts");
  const picturesDir = path.join(jobDir, "input", "pictures");
  await mkdir(fontsDir, { recursive: true });
  await mkdir(picturesDir, { recursive: true });
  const fonts: Record<string, unknown> = {};
  const written = new Map<string, string>();
  for (const [role, spec] of Object.entries(brand.tokens.font)) {
    const files: { path: string; weight: unknown; style: string }[] = [];
    for (const f of spec.files) {
      const rel = typeof f === "string" ? f : f.path;
      let target = written.get(rel);
      if (!target) {
        const res = await brand.resolver.resolve(`/brand/${rel}`).catch(() => null);
        if (!res) continue;
        target = path.join(fontsDir, `${written.size + 1}-${safeName(path.basename(rel))}`);
        await writeFile(target, res.body);
        written.set(rel, target);
      }
      files.push({
        path: target,
        weight: typeof f === "string" ? null : (f.weight ?? null),
        style:
          (typeof f === "string" ? undefined : f.style) ??
          (/italic/i.test(rel) ? "italic" : "normal"),
      });
    }
    fonts[role] = {
      family: spec.family,
      files,
      system: spec.system === true,
      defaultWeight: spec.default?.weight ?? null,
    };
  }
  const cache = new Map<string, { bytes: Uint8Array; ext: string } | null>();
  const pictures: Record<string, unknown>[] = [];
  for (const [i, p] of inputs.pictures.slice(0, MAX_PICTURES).entries()) {
    const file = await pictureBytes(deps, brand, p, signal, cache);
    if (!file) continue;
    const target = path.join(picturesDir, `${i + 1}-${safeName(p.name)}${file.ext}`);
    await writeFile(target, file.bytes);
    pictures.push({
      name: p.name,
      kind: p.kind,
      label: p.label,
      width: p.width ?? null,
      height: p.height ?? null,
      note: p.note ?? null,
      path: target,
    });
  }
  const slots: Record<string, string> = {};
  for (const [slotId, assetId] of Object.entries(inputs.slots)) {
    const file = await pictureBytes(
      deps,
      brand,
      { name: `slot:${slotId}`, kind: "slot", label: slotId, source: { assetId } },
      signal,
      cache,
    );
    if (!file) throw new Error(`Yuvaya yerleşecek görsel indirilemedi (${slotId}).`);
    const target = path.join(picturesDir, `slot-${safeName(slotId)}${file.ext}`);
    await writeFile(target, file.bytes);
    slots[slotId] = target;
  }
  const colors: Record<string, string> = {};
  for (const [name, token] of Object.entries(brand.tokens.color)) colors[name] = colorValue(token);
  return {
    version: 1,
    artboard: inputs.size,
    safeArea: inputs.safeArea,
    slides: inputs.slides,
    language: inputs.language,
    colors,
    usage: brand.tokens.usage ?? {},
    type: brand.tokens.type,
    fonts,
    pictures,
    slots,
    allowedNumbers: brand.allowedNumbers,
    seed: 7,
  };
}

// --- one run, checked ----------------------------------------------------------------------------

function runErrorOf(res: SandboxResult, timeoutMs: number): string | null {
  switch (res.status) {
    case "ok":
      return null;
    case "rejected":
      return `The static check refused the program:\n${res.problems.map((p) => `- ${p}`).join("\n")}`;
    case "error":
      return res.traceback || res.stderr.slice(-4_000) || "The program raised an error.";
    case "timeout":
      return `The program ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped: draw with numpy/Pillow operations instead of per-pixel Python loops, and fewer layers.`;
    case "memory":
      return "The program used too much memory and was stopped: work at the artboard size, avoid huge intermediate arrays.";
    default:
      return `The program could not run (exit ${res.exitCode ?? "signal"}): ${res.stderr.slice(-2_000)}`;
  }
}

export interface RunContext {
  deps: CodeEngineDeps;
  brand: BrandContext;
  inputs: CodeInputs;
  jobDir: string;
  lint: Omit<LintConfig, "width" | "height">;
  contentType: string;
  allowedNumbers: (count: number) => string[];
  signal: AbortSignal;
  onWait?: () => void;
}

export async function runAndCheck(
  rc: RunContext,
  label: string,
  output: CodeDesignOutput,
): Promise<CheckedCodeVersion> {
  const { deps, inputs, signal } = rc;
  const size = inputs.size;
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const base = {
    label,
    output,
    carousel: null,
    captionNumbers: [] as string[],
    warnings: [] as string[],
  };
  const pre = precheckProgram(output.program);
  if (pre.length > 0) {
    return {
      ...base,
      slides: [failedSlide(1, "the program was refused before it ran")],
      runError: `The static check refused the program:\n${pre.map((p) => `- ${p}`).join("\n")}`,
      runStatus: "precheck",
      errors: 1,
      warningCount: 0,
    };
  }
  const input = await prepareRunInput(deps, rc.brand, inputs, rc.jobDir, signal);
  const res = await runnerOf(deps).run({
    jobDir: rc.jobDir,
    program: output.program,
    input,
    timeoutMs,
    signal,
    ...(rc.onWait ? { onWait: rc.onWait } : {}),
  });
  const runError = runErrorOf(res, timeoutMs);
  const record = parseRunRecord(res.record);
  const numbers = [...res.slides.keys()].sort((a, b) => a - b);
  const slides: CheckedCodeSlide[] = [];
  const extra: string[] = [...record.warnings];
  if (runError) {
    slides.push(failedSlide(1, "the program did not finish"));
  } else {
    const count = numbers.length;
    if (count === 0) slides.push(failedSlide(1, "the program saved no slide (sb.save)"));
    for (let n = 1; n <= Math.max(...numbers, 0); n++) {
      const file = res.slides.get(n);
      if (!file) {
        slides.push(failedSlide(n, `slide ${n} was not saved (save slides 1..N without gaps)`));
        continue;
      }
      if (n > inputs.slides.max) {
        extra.push(`slide-${n}: more slides than allowed (${inputs.slides.max}); it was dropped`);
        continue;
      }
      const slide: CheckedCodeSlide = {
        id: `slide-${n}`,
        n,
        png: null,
        jpeg: null,
        record: record.slides.get(n) ?? null,
        report: null,
        failure: null,
      };
      try {
        const png = new Uint8Array(await readFile(file));
        const info = await inspectPng(png);
        if (info.width !== size.width || info.height !== size.height)
          slide.failure = `the PNG is ${info.width}x${info.height}, not ${size.width}x${size.height}`;
        else if (info.blank) slide.failure = "the slide is blank (one flat colour)";
        else {
          slide.png = png;
          slide.jpeg = await pngToSrgbJpeg(png, 92);
          slide.report = lintCodeSlide(slide.record, {
            ...rc.lint,
            ...(rc.lint.allowedNumbers ? { allowedNumbers: rc.allowedNumbers(count) } : {}),
            width: size.width,
            height: size.height,
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        slide.failure = `the PNG could not be read: ${(error as Error).message.slice(0, 200)}`;
      }
      slides.push(slide);
    }
    if (count > 0 && count < inputs.slides.min)
      extra.push(`only ${count} slide(s) saved; the brief asks for at least ${inputs.slides.min}`);
    for (const s of slides)
      if (s.record && s.record.texts.length === 0 && s.png)
        extra.push(
          `${s.id}: no text was recorded — draw every piece of copy with sb.text (text drawn otherwise is not checked)`,
        );
  }
  const reports = slides.map((s) => s.report).filter((r): r is LintReport => r !== null);
  const carousel =
    rc.contentType === "carousel" && reports.length === slides.length && reports.length > 1
      ? lintCarousel(reports)
      : null;
  const captionNumbers = rc.lint.allowedNumbers
    ? findUnverifiedNumbers(output.caption, rc.allowedNumbers(slides.length)).map((n) => n.text)
    : [];
  const tooFew = !runError && numbers.length > 0 && numbers.length < inputs.slides.min ? 1 : 0;
  const errors =
    slides.reduce((n, s) => n + (s.failure ? 1 : (s.report?.summary.errors ?? 0)), 0) +
    (carousel?.issues.filter((i) => i.severity === "error").length ?? 0) +
    captionNumbers.length +
    tooFew;
  const warningCount =
    slides.reduce((n, s) => n + (s.report?.summary.warnings ?? 0), 0) +
    (carousel?.issues.filter((i) => i.severity === "warning").length ?? 0);
  deps.logger.info(
    `[code] ${label}: ${res.status} in ${res.durationMs} ms, ${errors} error(s), ${warningCount} warning(s)${slides.map((s) => ` | ${s.id}: ${s.failure ?? `${s.report?.summary.errors ?? "?"}e/${s.report?.summary.warnings ?? "?"}w`}`).join("")}`,
  );
  return {
    ...base,
    slides,
    runError,
    runStatus: res.status,
    carousel,
    captionNumbers,
    warnings: extra,
    errors,
    warningCount,
  };
}

function failedSlide(n: number, failure: string): CheckedCodeSlide {
  return { id: `slide-${n}`, n, png: null, jpeg: null, record: null, report: null, failure };
}

export const usable = (v: CheckedCodeVersion) =>
  !v.runError && v.slides.length > 0 && v.slides.every((s) => s.jpeg && !s.failure);
export const hardFailures = (v: CheckedCodeVersion) =>
  v.runError ? 100 : v.slides.filter((s) => s.failure).length;
/** Fewer slides that could not be made first, then fewer errors (a tie keeps the newer). */
export const better = (next: CheckedCodeVersion, prev: CheckedCodeVersion) =>
  hardFailures(next) < hardFailures(prev) ||
  (hardFailures(next) === hardFailures(prev) && next.errors <= prev.errors);

/** Upload the renders and store the version (slides show the renders and carry the program). */
export async function storeCodeVersion(
  deps: CodeEngineDeps,
  o: {
    brandId: string;
    contentId: string;
    title: string;
    size: { width: number; height: number };
    language: string;
    slides: CheckedCodeSlide[];
    program: string;
    inputs: CodeInputs;
    origin: "generated" | "ai_edit" | "manual_edit";
    note: string;
    jobId?: string | undefined;
    signal: AbortSignal;
  },
): Promise<{
  version: ContentVersion;
  renderedAssetIds: string[];
  reports: Map<number, SlideReport>;
}> {
  const init = { signal: o.signal };
  const renderedAssetIds: string[] = [];
  for (const [i, slide] of o.slides.entries()) {
    const asset = await deps.api.client.assets.upload(
      {
        brandId: o.brandId,
        kind: "image",
        source: "generated",
        width: o.size.width,
        height: o.size.height,
        file: new Blob([(slide.jpeg as Uint8Array).slice()], { type: "image/jpeg" }),
        filename: `${slugify(o.title) || "post"}-kod-${i + 1}.jpg`,
      },
      init,
    );
    renderedAssetIds.push(asset.id);
  }
  const version = await deps.api.client.contents.versions.create(
    o.contentId,
    {
      origin: o.origin,
      slides: o.slides.map((s, i) => ({
        html: codeSlideHtml({
          index: s.n,
          width: o.size.width,
          height: o.size.height,
          src: `/media/${encodeURIComponent(renderedAssetIds[i] as string)}.jpg`,
          record: s.record,
          ...(i === 0 ? { program: o.program, inputs: o.inputs } : {}),
          lang: o.language,
        }),
        width: o.size.width,
        height: o.size.height,
      })),
      note: o.note.slice(0, 2000),
      ...(o.jobId ? { jobId: o.jobId } : {}),
      renderedAssetIds,
      layouts: o.slides.map((s) => layoutFromReport(s.report)),
    },
    init,
  );
  const reports = new Map<number, SlideReport>(
    o.slides.map((s, i) => [
      i,
      { report: s.report, failure: s.failure, jpegBytes: s.jpeg?.byteLength ?? null },
    ]),
  );
  return { version, renderedAssetIds, reports };
}

/** The empty image slots of code slides (what the slot-image line fills). */
export function emptyCodeSlots(slides: ReadonlyArray<{ html: string }>): EmptyImageSlot[] {
  const out: EmptyImageSlot[] = [];
  const seen = new Set<string>();
  for (const [slide, s] of slides.entries()) {
    for (const slot of codeSlideSlots(s.html)) {
      if (slot.state !== "empty" || seen.has(slot.id)) continue;
      seen.add(slot.id);
      const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(slot.ratio ?? "");
      out.push({
        slide,
        slotId: slot.id,
        ratio: m ? { w: Number(m[1]), h: Number(m[2]) } : null,
        label: slot.label,
      });
    }
  }
  return out;
}

// --- content.render: an approved picture into a slot -------------------------------------------

/**
 * Re-run the stored program of a code version with pictures assigned to its slots (the approval
 * of the slot's AI picture, `fill_post_slot`): a new `manual_edit` version, then the checks.
 */
export async function executeCodeSlotFill(o: {
  deps: CodeEngineDeps & {
    checks?: (input: {
      contentId: string;
      version: number;
      brand: BrandContext;
      reports: Map<number, SlideReport>;
    }) => Promise<unknown>;
  };
  content: Content;
  version: ContentVersion;
  slotAssignments: Record<string, string>;
  jobId?: string | undefined;
  note?: string | undefined;
  signal: AbortSignal;
  progress?: (value: number, message: string) => void;
}): Promise<{
  contentId: string;
  version: number;
  versionId: string;
  renderedAssetIds: (string | null)[];
  renderedSlides: number[];
}> {
  const { deps, content, signal } = o;
  const progress = o.progress ?? (() => {});
  const source = readCodeSource(o.version.slides);
  if (!source?.inputs)
    throw new Error("Bu sürümün kod motoru programı okunamadı; görsel yerleştirilemedi.");
  const known = new Set(o.version.slides.flatMap((s) => codeSlideSlots(s.html).map((x) => x.id)));
  for (const slotId of Object.keys(o.slotAssignments))
    if (!known.has(slotId)) throw new Error(`Görsel yuvası hiçbir slaytta bulunamadı: "${slotId}"`);
  const inputs: CodeInputs = {
    ...source.inputs,
    slots: { ...source.inputs.slots, ...o.slotAssignments },
  };
  progress(0.15, "Marka varlıkları hazırlanıyor");
  const brand = await loadBrandContext({
    api: deps.api,
    brandId: content.brandId,
    ...(inputs.profileVersion ? { profileVersion: inputs.profileVersion } : {}),
    cacheDir: path.join(deps.stateDir, "cache", "assets"),
    signal,
  });
  const runsRoot = path.join(runtimeRoot(deps.stateDir), "runs");
  const jobDir = await createJobDir(runsRoot, `${o.jobId ?? `fill-${Date.now()}`}-fill`);
  const rc: RunContext = {
    deps,
    brand,
    inputs,
    jobDir,
    lint: {
      safeArea: inputs.safeArea,
      brandFonts: brand.fontFamilies,
      systemFonts: brand.manifest.systemFontFamilies,
      ...(brand.allowedNumbers.length > 0 ? { allowedNumbers: brand.allowedNumbers } : {}),
      lang: inputs.language,
    },
    contentType: content.type,
    allowedNumbers: (count) => [
      ...new Set([
        ...brand.allowedNumbers,
        ...(content.type === "carousel"
          ? Array.from({ length: count }, (_, i) => String(i + 1))
          : []),
      ]),
    ],
    signal,
    onWait: () =>
      progress(0.3, "Kod motoru için Python ortamı hazırlanıyor (ilk kurulum birkaç dakika sürer)"),
  };
  progress(0.35, "Program onaylanan görselle yeniden çalıştırılıyor");
  let checked: CheckedCodeVersion;
  try {
    checked = await runAndCheck(rc, "fill", {
      program: source.program,
      caption: "",
      hashtags: [],
      rationale: "",
      critique: [],
      changes: [],
    });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!usable(checked))
    throw new Error(
      `Kod motorunun programı onaylanan görselle yeniden çalıştırılamadı (${
        checked.runError?.split("\n").pop()?.slice(0, 200) ??
        checked.slides
          .map((s) => s.failure)
          .filter(Boolean)
          .join("; ")
      }). Görseli sohbetten yeniden yerleştirmeyi isteyin.`,
    );
  progress(0.8, "Görseller yükleniyor");
  const stored = await storeCodeVersion(deps, {
    brandId: content.brandId,
    contentId: content.id,
    title: content.title,
    size: inputs.size,
    language: inputs.language,
    slides: checked.slides,
    program: source.program,
    inputs,
    origin: "manual_edit",
    note: [
      o.note ?? "",
      `Görsel yuvası dolduruldu (${Object.keys(o.slotAssignments).join(", ")}; v${o.version.version} programı yeniden çalıştı).`,
    ]
      .filter(Boolean)
      .join(" "),
    jobId: o.jobId,
    signal,
  });
  if (deps.checks) {
    progress(0.95, "Kontroller güncelleniyor");
    try {
      await deps.checks({
        contentId: content.id,
        version: stored.version.version,
        brand,
        reports: stored.reports,
      });
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`[code] checks after the slot fill failed: ${(error as Error).message}`);
    }
  }
  progress(1, "Tamamlandı");
  return {
    contentId: content.id,
    version: stored.version.version,
    versionId: stored.version.id,
    renderedAssetIds: stored.renderedAssetIds,
    renderedSlides: stored.renderedAssetIds.map((_, i) => i),
  };
}

/**
 * A stored code slide for the checks or a plain render: its render (the image it shows) and the
 * lint of what its program recorded. No Python runs.
 */
export async function renderStoredCodeSlide(input: {
  html: string;
  width: number;
  height: number;
  resolver: AssetResolver;
  lint: Omit<LintConfig, "width" | "height">;
}): Promise<{ jpeg: Uint8Array; report: LintReport }> {
  const src = codeRenderSrc(input.html);
  const res = src ? await input.resolver.resolve(src) : null;
  if (!res) throw new Error("Kod motoru slaytının görseli bulunamadı.");
  const isJpeg = res.body[0] === 0xff && res.body[1] === 0xd8;
  const jpeg = isJpeg ? res.body : await pngToSrgbJpeg(res.body, 92);
  const report = lintCodeSlide(readCodeRecord(input.html), {
    ...input.lint,
    width: input.width,
    height: input.height,
  });
  return { jpeg, report };
}

export function slugify(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
