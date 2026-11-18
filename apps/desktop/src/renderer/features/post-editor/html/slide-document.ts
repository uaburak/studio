// A slide's HTML as the import reads it (wecra/import.ts): the design exactly as stored, with
// brand.css inlined where its <link> is (same cascade order) and the virtual `/brand/` and
// `/media/` URLs mapped to the asset store, in a sandboxed frame without scripts (the
// renderer's rules: nothing in a design runs).
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
