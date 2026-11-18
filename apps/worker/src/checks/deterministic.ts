/**
 * Deterministic generation checks: the design-kit lint reports of the rendered slides (layout,
 * pixel contrast, fonts, images, numbers), carousel consistency, export limits, caption and
 * hashtag limits per platform, banned words and the brief. No model, no network: the same
 * input gives the same results.
 *
 * Lint findings keep their rule in `evidence.rule` (the fixes and the "fixed" bookkeeping key
 * on it); messages are Turkish.
 */
import {
  type BrandCheckSettings,
  CAPTION_LIMITS,
  CHECK_CATALOG,
  type CheckId,
  type CheckRef,
  type ContentCheckResult,
  type ContentType,
  isCheckEnabled,
  type Platform,
} from "@studio/contract";
import {
  type CarouselLintReport,
  type LintIssue,
  type LintReport,
  parseComputedColor,
} from "@studio/design-kit/lint";
import { type PlatformPreset, validateExport } from "@studio/design-kit/presets";
import { hexRgb } from "./fixes.ts";
import { characterCount, duplicateHashtags, excerpt, findBannedWords, hashtagsIn } from "./text.ts";

export interface SlideText {
  layer: string;
  role: string | null;
  text: string;
}

export interface CheckedSlide {
  /** 0-based. */
  index: number;
  width: number;
  height: number;
  /** Lint report of the render (`null` when the slide could not be rendered / linted). */
  report: LintReport | null;
  failure: string | null;
  /** Bytes of the rendered JPEG, when known (platform file limits). */
  jpegBytes: number | null;
  /** Visible text layers with their full text (from the HTML). */
  texts: SlideText[];
}

export interface DeterministicInput {
  contentType: ContentType;
  platforms: readonly Platform[];
  title: string;
  brief: string;
  caption: string;
  /** Slides to judge now (others may be carried over by the caller). */
  slides: readonly CheckedSlide[];
  carousel: CarouselLintReport | null;
  /** Numbers in the caption that are not in the brand facts (only when the brand has facts). */
  captionNumbers: readonly string[];
  /** Brand palette (`#RRGGBB`): tokens and the kit. Empty = colours are not compared. */
  palette: readonly string[];
  preset: PlatformPreset | null;
  settings: Pick<BrandCheckSettings, "disabledChecks" | "bannedWords" | "strictness">;
  /** `@names` in the brief that did not resolve to a file. */
  unresolvedAliases?: readonly string[];
  /** Can this finding be fixed automatically (decides `fixable`)? */
  canFix?: (finding: ContentCheckResult) => boolean;
}

/** Lint rule → check. Rules not listed are not reported as checks. */
export const RULE_CHECKS: Readonly<Record<string, CheckId>> = {
  "colour-literal": "brand.colors",
  "font-family": "brand.fonts",
  "font-load": "brand.fonts",
  "font-missing": "brand.fonts",
  "logo-src": "brand.logo",
  "logo-clear-space": "brand.logo",
  "text-logo-overlap": "brand.logo",
  "text-overflow-box": "layout.overflow",
  "text-clipped": "layout.overflow",
  "text-outside-artboard": "layout.overflow",
  "text-truncated": "layout.overflow",
  "text-line-clamp": "layout.overflow",
  "text-overlap": "layout.overflow",
  "text-occluded": "layout.overflow",
  "safe-area": "layout.safe-area",
  contrast: "layout.contrast",
  "contrast-busy-background": "layout.contrast",
  "min-font-size": "layout.legibility",
  "small-font-size": "layout.legibility",
  "diacritic-collision": "layout.legibility",
  widow: "layout.legibility",
  "carousel-artboard-mismatch": "layout.consistency",
  "carousel-anchor-drift": "layout.consistency",
  "carousel-counter": "layout.consistency",
  "carousel-font-drift": "layout.consistency",
  "image-upscaled": "visual.resolution",
  "image-broken": "visual.resolution",
  "artboard-size": "visual.resolution",
  "network-request": "visual.resolution",
  "image-distorted": "visual.distortion",
  "slot-ratio-mismatch": "visual.distortion",
  "unverified-number": "accuracy.claims",
  percentage: "accuracy.claims",
  "slot-empty": "brief.completeness",
};

/** Cosmetic rules the relaxed strictness drops. */
const RELAXED_DROP = new Set([
  "widow",
  "small-font-size",
  "contrast-busy-background",
  "diacritic-collision",
  "colour-literal",
  "percentage",
  "carousel-anchor-drift",
  "logo-clear-space",
]);

/** Info-level rules that still matter for a check (as warnings). */
const INFO_AS_WARN = new Set(["slot-empty"]);

/** Checks that judge rendered slides (not applicable to Reels). */
export const SLIDE_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  "brand.colors",
  "brand.fonts",
  "brand.logo",
  "layout.overflow",
  "layout.safe-area",
  "layout.contrast",
  "layout.legibility",
  "layout.consistency",
  "visual.resolution",
  "visual.distortion",
  "visual.logo-legibility",
]);

/** Checks the model pass decides (fully). `accuracy.claims` is shared with the numbers rule. */
export const MODEL_CHECKS: readonly CheckId[] = [
  "brand.voice",
  "text.language",
  "accuracy.products",
  "accuracy.claims",
];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Turkish message for a lint issue. */
export function lintMessage(issue: LintIssue, safeHint: string): string {
  const L = issue.layer ? `"${issue.layer.replace(/^\d+:/, "")}"` : "Bir öğe";
  const d = issue.data ?? {};
  switch (issue.rule) {
    case "text-overflow-box":
      return `${L} metni kutusuna sığmıyor.`;
    case "text-clipped":
      return `${L} metni kesiliyor (kutusu ya da üst grubu metni kırpıyor).`;
    case "text-outside-artboard":
      return `${L} metni görselin kenarından taşıyor.`;
    case "text-truncated":
      return `${L} metni üç noktayla kısaltılmış; metnin tamamı görünmüyor.`;
    case "text-line-clamp":
      return `${L} metni satır sınırıyla gizleniyor.`;
    case "text-overlap": {
      const other = str(d.other);
      return `${L} metni${other ? ` "${other}" metniyle` : " başka bir metinle"} çakışıyor.`;
    }
    case "text-occluded":
      return `${L} metni başka bir öğenin altında kalıyor.`;
    case "safe-area": {
      const px = num(d.overflow);
      return `${L} güvenli alanın ${px !== null ? `${Math.round(px)} px ` : ""}dışında${safeHint}.`;
    }
    case "contrast": {
      const median = num(d.median);
      const required = num(d.required);
      return median !== null && required !== null
        ? `${L} kontrastı ${median.toFixed(1)}:1; en az ${required}:1 olmalı.`
        : `${L} arka planına karşı yeterince okunmuyor.`;
    }
    case "contrast-busy-background": {
      const worst = num(d.worst);
      return `${L} arka planın bazı yerlerinde zor okunuyor${worst !== null ? ` (en düşük ${worst.toFixed(1)}:1)` : ""}.`;
    }
    case "min-font-size": {
      const px = num(d.fontSize);
      return `${L} yazısı çok küçük${px !== null ? ` (${Math.round(px)} px)` : ""}; en az 24 px olmalı.`;
    }
    case "small-font-size": {
      const px = num(d.fontSize);
      return `${L} yazısı${px !== null ? ` ${Math.round(px)} px;` : ""} okunurluk için 28 px ve üstü önerilir.`;
    }
    case "diacritic-collision":
      return `${L} içinde Türkçe harf işaretleri (İ, Ö, Ü, Ğ, Ç, Ş) komşu satıra değiyor.`;
    case "widow":
      return `${L} son satırında tek, kısa bir kelime kalmış.`;
    case "font-family": {
      const fam = str(d.family);
      return `${L} marka dışı bir font kullanıyor${fam ? ` (${fam})` : ""}.`;
    }
    case "font-load":
      return "Bir marka fontu yüklenemedi.";
    case "font-missing": {
      const fam = str(d.family);
      return `${fam ?? "Bir marka fontu"} bu Mac'te yüklü değil; yedek font kullanıldı.`;
    }
    case "colour-literal":
      return `${L} marka renk token'ı yerine sabit bir renk kullanıyor.`;
    case "logo-src":
      return `${L} logosu marka kitindeki dosyadan gelmiyor.`;
    case "logo-clear-space":
      return `${L} logosunun boşluk alanına başka bir öğe giriyor.`;
    case "text-logo-overlap":
      return `${L} metni logonun üzerine biniyor.`;
    case "carousel-artboard-mismatch":
      return "Carousel slaytları aynı boyutta değil.";
    case "carousel-anchor-drift":
      return `${L} her slaytta aynı yerde değil.`;
    case "carousel-counter":
      return `${L} sayacı slayt sırasıyla uyuşmuyor.`;
    case "carousel-font-drift":
      return "Aynı roldeki metinler slaytlar arasında farklı fontlarla yazılmış.";
    case "image-upscaled": {
      const scale = num(d.scale);
      return `${L} görseli piksel boyutunun ${scale !== null ? `%${Math.round(scale * 100)}'ü ile ` : "üstünde "}gösteriliyor; bulanık görünebilir.`;
    }
    case "image-broken":
      return `${L} görseli yüklenemedi.`;
    case "artboard-size":
      return "Slayt hedef boyutta render edilmedi.";
    case "network-request":
      return "Tasarım sunulmayan bir dosya istedi (eksik görsel ya da font).";
    case "image-distorted":
      return `${L} görseli esnetilmiş (en-boy oranı bozuk).`;
    case "slot-ratio-mismatch":
      return `${L} görsel yuvası kendi oranına uymuyor.`;
    case "unverified-number": {
      const n = str(d.number);
      return `${L} içindeki ${n ? `"${n}" ` : ""}rakamı markanın doğrulanmış bilgilerinde yok.`;
    }
    case "percentage":
      return `${L} yüzde içeriyor; doğrulanmış bir bilgi olduğundan emin olun.`;
    case "slot-empty":
      return `${L} görsel yuvası boş; yayından önce görsel eklenmeli.`;
    default:
      return issue.message;
  }
}

function refsOf(slideIndex: number | null, layer: string | null): CheckRef[] {
  if (slideIndex === null && !layer) return [];
  return [{ slide: slideIndex, layer: layer ? layer.slice(0, 64) : null }];
}

function result(
  checkId: CheckId,
  status: "warn" | "fail",
  message: string,
  refs: CheckRef[],
  evidence: Record<string, unknown> | null,
): ContentCheckResult {
  return {
    checkId,
    category: CHECK_CATALOG[checkId].category,
    status,
    message: message.slice(0, 600),
    refs,
    evidence,
    source: "deterministic",
    fixable: false,
  };
}

/** Lint issue → finding (or `null` when it is not a check problem). */
function fromLint(
  issue: LintIssue,
  slideIndex: number | null,
  input: DeterministicInput,
  safeHint: string,
): ContentCheckResult | null {
  const checkId = RULE_CHECKS[issue.rule];
  if (!checkId) return null;
  if (input.settings.strictness === "relaxed" && RELAXED_DROP.has(issue.rule)) return null;
  const status =
    issue.severity === "error"
      ? "fail"
      : issue.severity === "warning" || INFO_AS_WARN.has(issue.rule)
        ? "warn"
        : null;
  if (!status) return null;
  // Carousel issues name the slide: `2:counter` (1-based).
  let slide = slideIndex;
  let layer = issue.layer;
  const prefixed = layer ? /^(\d+):(.*)$/.exec(layer) : null;
  if (prefixed) {
    slide = Number(prefixed[1]) - 1;
    layer = prefixed[2] || null;
  }
  return result(checkId, status, lintMessage(issue, safeHint), refsOf(slide, layer), {
    rule: issue.rule,
    ...(issue.data ?? {}),
  });
}

function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}

const toHex = (rgb: readonly number[]) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** Findings of every enabled deterministic check (problems only; see `withPasses`). */
export function deterministicFindings(input: DeterministicInput): ContentCheckResult[] {
  const out: ContentCheckResult[] = [];
  const on = (id: CheckId) => isCheckEnabled(input.settings, id);
  const push = (r: ContentCheckResult | null) => {
    if (!r || !isCheckEnabled(input.settings, r.checkId as CheckId)) return;
    out.push(input.canFix?.(r) ? { ...r, fixable: true } : r);
  };
  const surface = input.preset?.surface;
  const safeHint =
    surface === "story"
      ? " (story arayüzünün altında kalabilir)"
      : surface === "reel-cover"
        ? " (Reels arayüzünün altında kalabilir)"
        : "";

  // --- slides: lint, palette, logo size, export limits ---
  const palette = input.palette.map(hexRgb).filter((c): c is [number, number, number] => !!c);
  for (const slide of input.slides) {
    if (slide.failure || !slide.report) {
      push(
        result(
          "visual.resolution",
          "fail",
          `Slayt ${slide.index + 1} render edilemedi${slide.failure ? `: ${excerpt(slide.failure, 160)}` : "."}`,
          refsOf(slide.index, null),
          { rule: "render-failed" },
        ),
      );
      continue;
    }
    for (const issue of slide.report.issues) push(fromLint(issue, slide.index, input, safeHint));

    if (on("brand.colors") && palette.length >= 2 && input.settings.strictness !== "relaxed") {
      let flagged = 0;
      for (const layer of slide.report.layers) {
        const color = layer.text?.color ? parseComputedColor(layer.text.color) : null;
        if (!color || color.a < 0.5 || flagged >= 6) continue;
        const nearest = Math.min(...palette.map((p) => colorDistance(p, color.rgb)));
        if (nearest <= 48) continue;
        flagged++;
        push(
          result(
            "brand.colors",
            "warn",
            `"${layer.id}" metin rengi (${toHex(color.rgb)}) marka paletinde yok.`,
            refsOf(slide.index, layer.id),
            { rule: "palette", color: toHex(color.rgb), distance: Math.round(nearest) },
          ),
        );
      }
    }

    if (on("visual.logo-legibility")) {
      const scale = slide.width / 1080;
      for (const layer of slide.report.layers) {
        if (layer.type !== "logo" || !layer.visible || !layer.rect) continue;
        const { w, h } = layer.rect;
        if (h >= 28 * scale && w >= 72 * scale) continue;
        push(
          result(
            "visual.logo-legibility",
            "warn",
            `"${layer.id}" logosu çok küçük (${Math.round(w)}×${Math.round(h)} px); telefonda okunmayabilir.`,
            refsOf(slide.index, layer.id),
            { rule: "logo-size", width: Math.round(w), height: Math.round(h) },
          ),
        );
      }
    }

    if (on("visual.resolution") && input.preset && slide.jpegBytes !== null) {
      const res = validateExport(input.preset, {
        format: "jpeg",
        width: slide.width,
        height: slide.height,
        bytes: slide.jpegBytes,
      });
      for (const i of res.issues) {
        push(
          result(
            "visual.resolution",
            i.severity === "error" ? "fail" : "warn",
            `Slayt ${slide.index + 1}: ${i.message}`,
            refsOf(slide.index, null),
            { rule: `export-${i.code}` },
          ),
        );
      }
    }
  }
  for (const issue of input.carousel?.issues ?? []) push(fromLint(issue, null, input, safeHint));

  // --- caption ---
  const caption = input.caption;
  const targets: Platform[] = input.platforms.length ? [...input.platforms] : ["instagram"];
  if (on("text.caption-length")) {
    const chars = characterCount(caption);
    if (!caption.trim() && input.contentType !== "story") {
      push(result("text.caption-length", "warn", "Açıklama boş.", [], { rule: "caption-empty" }));
    }
    for (const platform of targets) {
      const limit = CAPTION_LIMITS[platform].characters;
      if (chars > limit) {
        push(
          result(
            "text.caption-length",
            "fail",
            `Açıklama ${chars.toLocaleString("tr-TR")} karakter; ${PLATFORM_LABEL[platform]} sınırı ${limit.toLocaleString("tr-TR")}.`,
            [],
            { rule: "caption-length", platform, characters: chars, limit },
          ),
        );
      }
    }
  }
  if (on("text.hashtags")) {
    const count = hashtagsIn(caption).length;
    for (const platform of targets) {
      const limit = CAPTION_LIMITS[platform].hashtags;
      if (limit !== null && count > limit) {
        push(
          result(
            "text.hashtags",
            "fail",
            `${count} hashtag var; ${PLATFORM_LABEL[platform]} en fazla ${limit} kabul ediyor.`,
            [],
            { rule: "hashtag-count", platform, count, limit },
          ),
        );
      }
    }
    const dup = duplicateHashtags(caption);
    if (dup.length > 0) {
      push(
        result("text.hashtags", "warn", `Tekrarlanan hashtag: ${dup.slice(0, 5).join(", ")}.`, [], {
          rule: "hashtag-duplicate",
          tags: dup,
        }),
      );
    }
  }
  if (on("text.banned-words") && input.settings.bannedWords.length > 0) {
    for (const m of findBannedWords(caption, input.settings.bannedWords)) {
      push(
        result(
          "text.banned-words",
          "fail",
          `Açıklamada yasak ifade: "${m.match}" (${m.word}).`,
          [],
          { rule: "banned-word", word: m.word, match: m.match, where: "caption" },
        ),
      );
    }
    for (const slide of input.slides) {
      for (const t of slide.texts) {
        for (const m of findBannedWords(t.text, input.settings.bannedWords)) {
          push(
            result(
              "text.banned-words",
              "fail",
              `"${t.layer}" metninde yasak ifade: "${m.match}" (${m.word}).`,
              refsOf(slide.index, t.layer),
              { rule: "banned-word", word: m.word, match: m.match, where: "slide" },
            ),
          );
        }
      }
    }
  }
  if (on("accuracy.claims")) {
    for (const n of input.captionNumbers) {
      push(
        result(
          "accuracy.claims",
          "fail",
          `Açıklamadaki "${n}" rakamı markanın doğrulanmış bilgilerinde yok.`,
          [],
          { rule: "unverified-number", number: n, where: "caption" },
        ),
      );
    }
  }

  // --- brief ---
  if (on("brief.completeness")) {
    const brief = input.brief.trim();
    if (brief.length < 15) {
      push(
        result(
          "brief.completeness",
          "warn",
          brief
            ? "Brief çok kısa: ana mesaj, ürün ve çağrı (CTA) yazılırsa tasarım daha isabetli olur."
            : "Brief boş: tasarım yalnızca başlıktan üretildi.",
          [],
          { rule: "brief-short", length: brief.length },
        ),
      );
    }
    if (input.platforms.length === 0) {
      push(
        result(
          "brief.completeness",
          "warn",
          "Hedef platform seçilmemiş; Instagram varsayıldı.",
          [],
          { rule: "no-platform" },
        ),
      );
    }
    for (const alias of input.unresolvedAliases ?? []) {
      push(
        result("brief.completeness", "warn", `Brief'teki @${alias} bir dosyaya bağlanamadı.`, [], {
          rule: "unresolved-alias",
          alias,
        }),
      );
    }
  }
  return out;
}

const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/** A finding's identity across versions (fixed bookkeeping, carry-over). */
export function findingKey(r: Pick<ContentCheckResult, "checkId" | "refs" | "evidence">): string {
  const ref = r.refs[0];
  const rule = typeof r.evidence?.rule === "string" ? r.evidence.rule : "";
  const extra =
    typeof r.evidence?.platform === "string"
      ? r.evidence.platform
      : typeof r.evidence?.word === "string"
        ? r.evidence.word
        : typeof r.evidence?.other === "string"
          ? r.evidence.other
          : "";
  return `${r.checkId}|${ref?.slide ?? ""}|${ref?.layer ?? ""}|${rule}|${extra}`;
}

/**
 * Adds one `pass` row for every enabled check in `ran` that has no other row, so the list
 * shows what was checked.
 */
export function withPasses(
  results: readonly ContentCheckResult[],
  ran: Iterable<CheckId>,
): ContentCheckResult[] {
  const seen = new Set(results.map((r) => r.checkId));
  const out = [...results];
  for (const id of ran) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      checkId: id,
      category: CHECK_CATALOG[id].category,
      status: "pass",
      message: CHECK_CATALOG[id].description,
      refs: [],
      evidence: null,
      source: CHECK_CATALOG[id].source === "model" ? "model" : "deterministic",
      fixable: false,
    });
  }
  return out;
}

/** A `skipped` row (the check could not run). */
export function skipped(id: CheckId, message: string): ContentCheckResult {
  return {
    checkId: id,
    category: CHECK_CATALOG[id].category,
    status: "skipped",
    message,
    refs: [],
    evidence: null,
    source: CHECK_CATALOG[id].source === "model" ? "model" : "deterministic",
    fixable: false,
  };
}
