/**
 * Slide previews. Slides are complete HTML documents written by the
 * generation agent (untrusted input). They are shown in an iframe that:
 *
 * - has `sandbox=""` (no scripts, no same-origin, no forms, no popups, no
 *   top navigation), and
 * - gets a strict Content-Security-Policy injected as the first element of
 *   <head>, so the document cannot load anything from the network (only
 *   inline styles and data: URIs).
 *
 * The artboard renders at its native pixel size and is scaled down with a
 * CSS transform to fit the available box.
 */

/** Empty sandbox token list: every capability is denied. */
export const SLIDE_SANDBOX = "";

export const SLIDE_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`;
const RESET_STYLE = "<style>html{overflow:hidden}</style>";

/** Tags that could navigate the frame or change URL resolution. */
const STRIP_PATTERNS = [
  /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
  /<base\b[^>]*>/gi,
];

/**
 * Wrap a slide document for previewing: strip navigation tags and put the
 * CSP meta first inside <head> (creating <head>/<html> when missing).
 */
export function buildSlideSrcdoc(html: string): string {
  let doc = html;
  for (const pattern of STRIP_PATTERNS) doc = doc.replace(pattern, "");
  const inject = CSP_META + RESET_STYLE;

  const head = /<head\b[^>]*>/i.exec(doc);
  if (head) {
    const at = head.index + head[0].length;
    return doc.slice(0, at) + inject + doc.slice(at);
  }
  const root = /<html\b[^>]*>/i.exec(doc);
  if (root) {
    const at = root.index + root[0].length;
    return `${doc.slice(0, at)}<head>${inject}</head>${doc.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(doc);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return `${doc.slice(0, at)}<head>${inject}</head>${doc.slice(at)}`;
  }
  return `<!doctype html><head>${inject}</head>${doc}`;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Scale factor that fits `artboard` inside `box` without upscaling past
 * `maxScale`. Returns 0 for an empty box (not measured yet).
 */
export function fitScale(artboard: Size, box: Partial<Size>, maxScale = 1): number {
  if (artboard.width <= 0 || artboard.height <= 0) return 0;
  const candidates = [maxScale];
  if (box.width !== undefined) candidates.push(box.width / artboard.width);
  if (box.height !== undefined) candidates.push(box.height / artboard.height);
  const scale = Math.min(...candidates);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

/** Human label for an artboard: "1080 × 1350 · 4:5". */
export function describeArtboard({ width, height }: Size): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  const ratio = `${width / d}:${height / d}`;
  const known: Record<string, string> = { "4:5": "4:5", "1:1": "1:1", "9:16": "9:16" };
  return `${width} × ${height}${known[ratio] ? ` · ${known[ratio]}` : ""}`;
}

/** Carousel index after a step, clamped to the slides (no wrap, like Instagram). */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}
