// A slide's HTML as the canvas loads it: the design exactly as stored, with brand.css inlined
// where its <link> is (same cascade order) and the virtual `/brand/` and `/media/` URLs mapped
// to the asset store, in a sandboxed frame without scripts (the renderer's rules: nothing in a
// design runs). Edits morph the live document in place (no reload, images stay decoded); a
// change in <head> reloads it.
import { type RenderKit, resolveVirtualUrl } from "../model/brand-kit.ts";

/** The renderer's policy, as the design-kit preview uses it (assets only from the app). */
export const SLIDE_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; media-src 'none'; img-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'";

/** Marks the editor's own additions in a slide document. */
export const EDITOR_ATTR = "data-studio-editor";

function mapUrls(doc: Document, kit: Pick<RenderKit, "files">): void {
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src") ?? "";
    const mapped = resolveVirtualUrl(src, kit.files);
    if (mapped) img.setAttribute("src", mapped);
  }
  for (const source of Array.from(doc.querySelectorAll("source[srcset]"))) {
    const mapped = resolveVirtualUrl(source.getAttribute("srcset") ?? "", kit.files);
    if (mapped) source.setAttribute("srcset", mapped);
  }
}

/** The document for the slide's frame. */
export function slideDocument(html: string, kit: Pick<RenderKit, "css" | "files">): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", SLIDE_CSP);
  meta.setAttribute(EDITOR_ATTR, "csp");
  doc.head.prepend(meta);
  let inlined = false;
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
    if (link.getAttribute("href") === "/brand/brand.css") {
      const style = doc.createElement("style");
      style.setAttribute(EDITOR_ATTR, "brand");
      style.textContent = kit.css;
      link.replaceWith(style);
      inlined = true;
    } else {
      link.remove(); // the renderer serves brand.css only
    }
  }
  if (!inlined) {
    // A design without the link still renders unstyled by the brand: keep it so.
  }
  // Editor-only: no text selection or caret on the canvas; links never navigate.
  const editor = doc.createElement("style");
  editor.setAttribute(EDITOR_ATTR, "chrome");
  editor.textContent =
    "html,body{cursor:default}*{-webkit-user-select:none;user-select:none}[contenteditable]{-webkit-user-select:text;user-select:text;cursor:text;outline:none;caret-color:currentColor}";
  doc.head.append(editor);
  mapUrls(doc, kit);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// --- morphing ---------------------------------------------------------------------------------------

function syncAttributes(target: Element, source: Element): void {
  for (const attr of Array.from(target.attributes)) {
    if (!source.hasAttribute(attr.name) && attr.name !== "contenteditable")
      target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  const ea = a as Element;
  const eb = b as Element;
  return (
    ea.tagName === eb.tagName &&
    (ea.getAttribute("data-layer") ?? null) === (eb.getAttribute("data-layer") ?? null)
  );
}

function morphNode(target: Node, source: Node, doc: Document): void {
  if (target.nodeType === 3 || target.nodeType === 8) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return;
  }
  if (target.nodeType !== 1) return;
  syncAttributes(target as Element, source as Element);
  const tc = Array.from(target.childNodes);
  const sc = Array.from(source.childNodes);
  let i = 0;
  for (; i < sc.length; i++) {
    const s = sc[i] as Node;
    const t = tc[i];
    if (!t) {
      target.appendChild(doc.importNode(s, true));
      continue;
    }
    if (sameKind(t, s)) morphNode(t, s, doc);
    else {
      // A layer that moved in the stack, was added or deleted: find it further on.
      const id = s.nodeType === 1 ? (s as Element).getAttribute("data-layer") : null;
      const later = id
        ? tc
            .slice(i + 1)
            .find((n) => n.nodeType === 1 && (n as Element).getAttribute("data-layer") === id)
        : null;
      if (later && sameKind(later, s)) {
        target.insertBefore(later, t);
        tc.splice(tc.indexOf(later), 1);
        tc.splice(i, 0, later);
        morphNode(later, s, doc);
      } else {
        const fresh = doc.importNode(s, true);
        target.replaceChild(fresh, t);
        tc[i] = fresh as ChildNode;
      }
    }
  }
  for (let j = tc.length - 1; j >= i; j--) tc[j]?.remove();
}

/**
 * Brings the live document to `nextSrcdoc`: the body is morphed in place; anything else
 * (head: the design's CSS, brand.css) returns "reload" and the caller sets srcdoc again.
 */
export function morphDocument(doc: Document, nextSrcdoc: string): "morphed" | "reload" {
  const next = new DOMParser().parseFromString(nextSrcdoc, "text/html");
  if (doc.head.innerHTML !== next.head.innerHTML) return "reload";
  if (doc.documentElement.getAttribute("lang") !== next.documentElement.getAttribute("lang"))
    return "reload";
  syncAttributes(doc.body, next.body);
  morphNode(doc.body, next.body, doc);
  return "morphed";
}
