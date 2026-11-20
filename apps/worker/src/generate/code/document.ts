/**
 * The code engine's slide document (docs/URETIM-RESIM.md, Faz 4).
 *
 * The program draws PNGs; what a version stores per slide is a small HTML document that shows
 * the slide's render (so the content hash covers exactly the picture the owner approves, and a
 * PDF/PNG export renders it like any slide) and carries the engine's source in meta tags:
 *
 *   <!doctype html>
 *   <html lang="tr" data-studio-engine="code">
 *   <head>
 *     <meta name="studio:code-slide" content="2">              this slide's number in the program
 *     <meta name="studio:code-record" content="{…}">           what the program drew (checks, slots)
 *     <meta name="studio:code-program" content="<base64>">     the Python program (first slide only)
 *     <meta name="studio:code-inputs" content="{…}">           pictures, filled slots… (first slide only)
 *   </head>
 *   <body><img src="/media/<assetId>.jpg" width=W height=H alt="…"></body>
 *   </html>
 *
 * `readCodeSource` gives the program and its inputs back for a chat revision or a re-run (an
 * approved picture placed into a slot re-runs the program with that picture assigned).
 */
import { CODE_RECORD_META, isCodeSlideHtml, slideMetaContent } from "@studio/contract";

export const CODE_SLIDE_META = "studio:code-slide";
export const CODE_PROGRAM_META = "studio:code-program";
export const CODE_INPUTS_META = "studio:code-inputs";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CodeTextRecord {
  id: string;
  text: string;
  rect: Box;
  fontSize: number;
  weight: string;
  family: string;
  role?: string | null;
  color: string;
  lines: number;
  legal: boolean;
  /** RGB of the background under the text before it was drawn (5/50/95 % luminance). */
  background: { median: number[]; dark: number[]; light: number[] } | null;
  maxWidth?: number | null;
  /**
   * The block's line boxes (top of the first line to the last line's advance), the space it takes
   * with its line spacing. `rect` is the ink. Absent in records written before it was recorded.
   */
  lineBox?: Box | null;
  /** `sb.text(..., allow_overlap=True)`: meant to sit on other text. */
  allowOverlap?: boolean;
}

export interface CodeImageRecord {
  id: string;
  name: string;
  kind: string;
  rect: Box;
  fit: string;
}

export interface CodeSlotRecord {
  id: string;
  state: "empty" | "filled";
  ratio: string | null;
  label: string | null;
  rect: Box;
  radius: number;
}

export interface CodeSlideRecord {
  texts: CodeTextRecord[];
  images: CodeImageRecord[];
  slots: CodeSlotRecord[];
  /** Brand families the program loaded (`studio_brand.font`). */
  fonts: { family: string; status: string }[];
}

export interface CodeRunRecord {
  slides: Map<number, CodeSlideRecord>;
  warnings: string[];
}

/** A picture the program may draw, and where it comes from (to rebuild it for a re-run). */
export interface CodePicture {
  /** The name the program uses: `logo/<name>`, `brand/<name>`, `@image`, `product/<slug>-1`. */
  name: string;
  kind: string;
  label: string;
  width?: number | null;
  height?: number | null;
  note?: string;
  source: { brandPath: string } | { assetId: string };
}

/** What a run needs besides the program and the brand (stored with the program). */
export interface CodeInputs {
  version: 1;
  size: { width: number; height: number };
  safeArea: { top: number; right: number; bottom: number; left: number };
  slides: { min: number; max: number };
  language: string;
  profileVersion: number | null;
  pictures: CodePicture[];
  /** Filled image slots: slot id → the approved picture's asset id. */
  slots: Record<string, string>;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const box = (v: unknown): Box => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { x: num(o.x), y: num(o.y), w: Math.max(0, num(o.w)), h: Math.max(0, num(o.h)) };
};
const rgb = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number")
    ? (v.slice(0, 3) as number[])
    : null;

function parseSlideRecord(raw: unknown, fonts: { family: string; status: string }[]) {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
  const texts: CodeTextRecord[] = arr(o.texts)
    .filter((t) => t && typeof t === "object")
    .slice(0, 200)
    .map((t, i) => {
      const bg = (t.background && typeof t.background === "object" ? t.background : null) as Record<
        string,
        unknown
      > | null;
      const median = rgb(bg?.median);
      const dark = rgb(bg?.dark);
      const light = rgb(bg?.light);
      return {
        id: str(t.id, `text-${i + 1}`).slice(0, 64) || `text-${i + 1}`,
        text: str(t.text).slice(0, 2_000),
        rect: box(t.rect),
        fontSize: num(t.fontSize, 0),
        weight: String(t.weight ?? "400"),
        family: str(t.family),
        role: typeof t.role === "string" ? t.role : null,
        color: str(t.color, "rgb(0, 0, 0)"),
        lines: Math.max(1, Math.round(num(t.lines, 1))),
        legal: t.legal === true,
        background: median && dark && light ? { median, dark, light } : null,
        maxWidth: typeof t.maxWidth === "number" ? t.maxWidth : null,
        lineBox: t.lineBox && typeof t.lineBox === "object" ? box(t.lineBox) : null,
        allowOverlap: t.allowOverlap === true,
      };
    });
  const images: CodeImageRecord[] = arr(o.images)
    .slice(0, 100)
    .map((m, i) => ({
      id: str(m.id, `image-${i + 1}`).slice(0, 64),
      name: str(m.name),
      kind: str(m.kind, "image"),
      rect: box(m.rect),
      fit: str(m.fit, "cover"),
    }));
  const slots: CodeSlotRecord[] = arr(o.slots)
    .slice(0, 20)
    .filter((s) => typeof s.id === "string" && s.id)
    .map((s) => ({
      id: str(s.id).slice(0, 64),
      state: s.state === "filled" ? "filled" : "empty",
      ratio: typeof s.ratio === "string" ? s.ratio : null,
      label: typeof s.label === "string" ? s.label : null,
      rect: box(s.rect),
      radius: num(s.radius),
    }));
  return { texts, images, slots, fonts };
}

/** `record.json` (what studio_brand recorded) → per slide records. */
export function parseRunRecord(raw: unknown): CodeRunRecord {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fontsRaw = (o.fonts && typeof o.fonts === "object" ? o.fonts : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const fonts = Object.values(fontsRaw)
    .filter((f) => f && typeof f.family === "string")
    .map((f) => ({ family: String(f.family), status: str(f.status, "loaded") }));
  const slides = new Map<number, CodeSlideRecord>();
  const slidesRaw = (o.slides && typeof o.slides === "object" ? o.slides : {}) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(slidesRaw)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > 20) continue;
    slides.set(n, parseSlideRecord(value, fonts));
  }
  const warnings = Array.isArray(o.warnings)
    ? o.warnings.filter((w): w is string => typeof w === "string").slice(0, 20)
    : [];
  return { slides, warnings };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The stored document of one code slide. */
export function codeSlideHtml(input: {
  /** 1-based slide number. */
  index: number;
  width: number;
  height: number;
  /** `/media/<assetId>.jpg`: the slide's render. */
  src: string;
  record: CodeSlideRecord | null;
  /** The program and its inputs (the first slide carries them). */
  program?: string;
  inputs?: CodeInputs;
  lang: string;
  alt?: string;
}): string {
  const lang = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.lang) ? input.lang : "tr";
  const record = input.record ?? { texts: [], images: [], slots: [], fonts: [] };
  const alt =
    input.alt ??
    record.texts
      .map((t) => t.text)
      .join(" ")
      .slice(0, 300);
  return [
    "<!doctype html>",
    `<html lang="${lang}" data-studio-engine="code">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="${CODE_SLIDE_META}" content="${input.index}">`,
    `<meta name="${CODE_RECORD_META}" content="${escapeAttr(JSON.stringify(record))}">`,
    ...(input.program !== undefined
      ? [
          `<meta name="${CODE_PROGRAM_META}" content="${Buffer.from(input.program, "utf8").toString("base64")}">`,
        ]
      : []),
    ...(input.inputs
      ? [`<meta name="${CODE_INPUTS_META}" content="${escapeAttr(JSON.stringify(input.inputs))}">`]
      : []),
    `<style>html, body { margin: 0; padding: 0; width: ${input.width}px; height: ${input.height}px; overflow: hidden; } img { display: block; width: ${input.width}px; height: ${input.height}px; }</style>`,
    "</head>",
    "<body>",
    `<img src="${escapeAttr(input.src)}" width="${input.width}" height="${input.height}" alt="${escapeAttr(alt)}">`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The program and its inputs of a code version (null: not a code version or no program). */
export function readCodeSource(
  slides: ReadonlyArray<{ html: string }>,
): { program: string; inputs: CodeInputs | null } | null {
  for (const s of slides) {
    if (!isCodeSlideHtml(s.html)) continue;
    const b64 = slideMetaContent(s.html, CODE_PROGRAM_META);
    if (!b64) continue;
    const program = Buffer.from(b64, "base64").toString("utf8");
    let inputs: CodeInputs | null = null;
    const raw = slideMetaContent(s.html, CODE_INPUTS_META);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CodeInputs;
        if (parsed && parsed.version === 1) inputs = parsed;
      } catch {
        inputs = null;
      }
    }
    return { program, inputs };
  }
  return null;
}

/** What the program drew on a stored code slide (null: not a code slide). */
export function readCodeRecord(html: string): CodeSlideRecord | null {
  if (!isCodeSlideHtml(html)) return null;
  const raw = slideMetaContent(html, CODE_RECORD_META);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const fonts = Array.isArray(o.fonts)
      ? (o.fonts as Record<string, unknown>[])
          .filter((f) => f && typeof f.family === "string")
          .map((f) => ({ family: String(f.family), status: str(f.status, "loaded") }))
      : [];
    return parseSlideRecord(o, fonts);
  } catch {
    return null;
  }
}

/** The render a stored code slide shows (`/media/<assetId>.<ext>`). */
export function codeRenderSrc(html: string): string | null {
  const m = /<img\s+src="(\/media\/[^"]+)"/.exec(html);
  return m?.[1] ?? null;
}

/** The visible copy of a code slide (the checks' text list). */
export function codeTexts(html: string): { id: string; text: string }[] {
  return (readCodeRecord(html)?.texts ?? [])
    .filter((t) => t.text.trim())
    .map((t) => ({ id: t.id, text: t.text }));
}
