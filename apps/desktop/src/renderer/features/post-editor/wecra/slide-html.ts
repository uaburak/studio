// A slide saved from the canvas, as the design contract stores it (`@studio/design-kit/canvas`):
// the render Wecra's engine exported as the artboard's bottom image layer (`data-layer="canvas"`,
// its SHA-256 in a meta tag — so the version's content hash, what approval is bound to, changes
// with every pixel), and above it the slide's texts, image slots, logos and pictures as
// invisible `data-layer` elements at their places, with the slide's canvas facts (every layer,
// text, font, colour; `facts.ts`) in `<meta name="studio:canvas">` and a short alt text from the
// real texts. The worker renders it to the same pixels; checks, the AI and the iPhone read the
// layers and the facts; previews and publishing use the render itself (the version's rendered
// asset).
import {
  type CanvasFacts,
  type CanvasLayoutBox,
  canvasLayout,
  canvasSlideHtml as kitCanvasSlideHtml,
  readCanvas,
} from "@studio/design-kit/canvas";

/** The slide HTML of a canvas render (`facts: null`: the facts could not be read — one image). */
export function canvasSlideHtml(o: {
  src: string;
  sha256: string;
  width: number;
  height: number;
  facts: CanvasFacts | null;
  /** The HTML version the canvas document was imported from (the AI edits from there). */
  sourceVersion?: number | null;
}): string {
  if (o.facts)
    return kitCanvasSlideHtml({
      facts: o.facts,
      src: o.src,
      sha256: o.sha256,
      sourceVersion: o.sourceVersion ?? null,
    });
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="${o.width}x${o.height}">
  <meta name="studio:editor" content="wecra">
  <meta name="studio:render" content="sha256:${o.sha256}">${o.sourceVersion ? `\n  <meta name="studio:source-version" content="${o.sourceVersion}">` : ""}
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    html, body { margin: 0; }
    [data-artboard] { position: relative; overflow: hidden; }
  </style>
</head>
<body>
  <main data-artboard style="width:${o.width}px;height:${o.height}px">
    <img data-layer="canvas" data-type="image" data-role="background" src="${esc(o.src)}" alt="" style="position:absolute;left:0;top:0;width:${o.width}px;height:${o.height}px">
  </main>
</body>
</html>`;
}

/** The layer boxes a canvas slide's version stores (measured: no measuring render follows). */
export function canvasSlideLayout(
  facts: CanvasFacts | null,
  width: number,
  height: number,
): CanvasLayoutBox[] {
  if (facts) return canvasLayout(facts);
  return [
    {
      id: "canvas",
      type: "image",
      role: "background",
      parent: null,
      x: 0,
      y: 0,
      w: width,
      h: height,
      visible: true,
    },
  ];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Of a version's slide HTML: saved from the canvas (Wecra's render), and the HTML version it came from. */
export function canvasOrigin(html: string | undefined): {
  canvas: boolean;
  sourceVersion: number | null;
} {
  const c = readCanvas(html);
  return c.kind === "none"
    ? { canvas: false, sourceVersion: null }
    : { canvas: true, sourceVersion: c.sourceVersion };
}
