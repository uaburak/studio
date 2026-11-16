/**
 * One security policy for every place a design is shown: the renderer sends it as a
 * response header, the editor preview embeds it as `<meta http-equiv>` in a sandboxed
 * `srcdoc` iframe. Scripts, frames, forms, connections and media are off; images, fonts
 * and stylesheets may only come from the asset origins.
 */
import { tokenizeCss } from "../html/css.ts";
import {
  applySplices,
  attrRange,
  attrValueRange,
  elementRanges,
  escapeAttr,
  getAttr,
  isElement,
  type P5Element,
  parseDocument,
  type Splice,
  walkElements,
} from "../html/dom.ts";
import { type SanitizeFinding, sanitizeSlideHtml } from "./sanitize.ts";

export interface CspOptions {
  /**
   * Sources allowed for images, fonts and stylesheets. Default `'self'` (the renderer's
   * virtual origin, or the editor's own origin for `allow-same-origin` previews).
   */
  assetSources?: readonly string[];
}

const SOURCE_PATTERN = /^('self'|https?:\/\/[a-z0-9.-]+(:\d{1,5})?)$/i;

export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  const sources = options.assetSources?.length ? [...options.assetSources] : ["'self'"];
  for (const s of sources) if (!SOURCE_PATTERN.test(s)) throw new Error(`invalid CSP source: ${s}`);
  const src = sources.join(" ");
  return [
    "default-src 'none'",
    "script-src 'none'",
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "manifest-src 'none'",
    `img-src ${src}`,
    `font-src ${src}`,
    `style-src ${src} 'unsafe-inline'`,
  ].join("; ");
}

/** The policy with `'self'` as the only asset source (renderer default). */
export const STRICT_CSP = buildContentSecurityPolicy();

/**
 * Sandbox for preview iframes. No `allow-scripts`: nothing in the design can run.
 * `allow-same-origin` lets the editor (parent page) read and edit the preview DOM and run
 * the in-page lint checks against it; without scripts in the frame this is safe.
 */
export const PREVIEW_SANDBOX = "allow-same-origin";

export interface PreviewAssets {
  /** Absolute URL that `/brand/` maps to, ending with `/` (e.g. `https://studio.example/api/brands/b1/files/`). */
  brand: string;
  /** Absolute URL that `/media/` maps to, ending with `/`. */
  media: string;
}

export interface PreviewOptions {
  /** Where the editor serves brand files and media. Omit when it serves `/brand/` and `/media/` itself. */
  assets?: PreviewAssets;
  /** Sanitise before building (default true). Pass false only for HTML that is already sanitised. */
  sanitize?: boolean;
}

export interface PreviewDocument {
  /** Value for `iframe.srcdoc` (set it as a DOM property, or escape it for markup). */
  srcdoc: string;
  csp: string;
  /** Attributes for the iframe element. */
  iframe: { sandbox: string; referrerpolicy: string; csp: string };
  findings: SanitizeFinding[];
}

function originOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error(`asset URL must be http(s): ${url}`);
  if (!u.pathname.endsWith("/")) throw new Error(`asset base URL must end with "/": ${url}`);
  return u.origin;
}

function rewriteUrl(url: string, assets: PreviewAssets): string {
  if (url.startsWith("/brand/")) return assets.brand + url.slice("/brand/".length);
  if (url.startsWith("/media/")) return assets.media + url.slice("/media/".length);
  return url;
}

function rewriteCss(css: string, assets: PreviewAssets): string {
  const splices: Splice[] = [];
  const tokens = tokenizeCss(css);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.type === "url" && (t.value.startsWith("/brand/") || t.value.startsWith("/media/")))
      splices.push({ start: t.start, end: t.end, text: `url("${rewriteUrl(t.value, assets)}")` });
    if (t.type === "string" && (t.value.startsWith("/brand/") || t.value.startsWith("/media/"))) {
      const prev = tokens
        .slice(0, i)
        .reverse()
        .find((p) => p.type !== "whitespace");
      if (prev?.type === "function")
        splices.push({ start: t.start, end: t.end, text: `"${rewriteUrl(t.value, assets)}"` });
    }
  }
  return applySplices(css, splices);
}

/** Map `/brand/` and `/media/` URLs to the editor's asset URLs (preview copy only). */
export function rewriteVirtualUrls(html: string, assets: PreviewAssets): string {
  const doc = parseDocument(html);
  const splices: Splice[] = [];
  const replaceAttr = (el: P5Element, name: string, value: string) => {
    const r = attrRange(el, name);
    const vr = r ? attrValueRange(html, r) : null;
    if (r && vr && vr.quote === '"')
      splices.push({ start: vr.start, end: vr.end, text: escapeAttr(value) });
    else if (r)
      splices.push({ start: r.start, end: r.end, text: `${name}="${escapeAttr(value)}"` });
  };
  for (const el of walkElements(doc)) {
    if (el.tagName === "img") {
      const src = getAttr(el, "src");
      if (src && rewriteUrl(src, assets) !== src) replaceAttr(el, "src", rewriteUrl(src, assets));
    }
    if (el.tagName === "link") {
      const href = getAttr(el, "href");
      if (href && rewriteUrl(href, assets) !== href)
        replaceAttr(el, "href", rewriteUrl(href, assets));
    }
    const style = getAttr(el, "style");
    if (style && /url|\\/i.test(style)) {
      const next = rewriteCss(style, assets);
      if (next !== style) replaceAttr(el, "style", next);
    }
    if (el.tagName === "style") {
      const r = elementRanges(el);
      if (r) {
        const css = html.slice(r.inner.start, r.inner.end);
        const next = rewriteCss(css, assets);
        if (next !== css) splices.push({ start: r.inner.start, end: r.inner.end, text: next });
      }
    }
  }
  return applySplices(html, splices);
}

/** Insert `<meta http-equiv="Content-Security-Policy">` as early as possible in `<head>`. */
export function injectCspMeta(html: string, csp: string): string {
  const doc = parseDocument(html);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`;
  const htmlEl = doc.childNodes.find(isElement);
  const head = htmlEl?.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === "head");
  const headRanges = head ? elementRanges(head) : null;
  if (headRanges)
    return applySplices(html, [
      { start: headRanges.startTag.end, end: headRanges.startTag.end, text: meta },
    ]);
  const htmlRanges = htmlEl ? elementRanges(htmlEl) : null;
  if (htmlRanges)
    return applySplices(html, [
      {
        start: htmlRanges.startTag.end,
        end: htmlRanges.startTag.end,
        text: `<head>${meta}</head>`,
      },
    ]);
  const doctype = doc.childNodes.find((n) => n.nodeName === "#documentType");
  const at = doctype?.sourceCodeLocation?.endOffset ?? 0;
  return applySplices(html, [{ start: at, end: at, text: meta }]);
}

/**
 * Build the `srcdoc` for a sandboxed preview iframe: sanitise, map asset URLs, embed the
 * CSP. Web previews, Mac renders and exports then run under the same rules.
 */
export function buildPreviewDocument(html: string, options: PreviewOptions = {}): PreviewDocument {
  const sanitized = options.sanitize === false ? { html, findings: [] } : sanitizeSlideHtml(html);
  let out = sanitized.html;
  let sources: string[] = ["'self'"];
  if (options.assets) {
    sources = [...new Set([originOf(options.assets.brand), originOf(options.assets.media)])];
    out = rewriteVirtualUrls(out, options.assets);
  }
  const csp = buildContentSecurityPolicy({ assetSources: sources });
  return {
    srcdoc: injectCspMeta(out, csp),
    csp,
    iframe: { sandbox: PREVIEW_SANDBOX, referrerpolicy: "no-referrer", csp },
    findings: sanitized.findings,
  };
}
