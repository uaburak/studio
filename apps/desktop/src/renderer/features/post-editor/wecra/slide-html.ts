// A slide saved from the canvas, as the design contract stores it: the render Wecra's engine
// exported, as the artboard's one image layer (`data-layer="canvas"`), with its SHA-256 in a
// meta tag — so the version's content hash (what approval is bound to) changes with every pixel
// — and the slide's texts as the image's alt text. The worker renders it like any slide (to the
// same pixels); previews, checks and publishing use the render itself (the version's rendered
// asset).
/** The slide HTML of a canvas render: the render as the artboard's one image layer. */
export function canvasSlideHtml(o: {
  src: string;
  sha256: string;
  width: number;
  height: number;
  text: string;
  /** The HTML version the canvas document was imported from (the AI edits from there). */
  sourceVersion?: number | null;
}): string {
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
  <style>
    html, body { margin: 0; }
    [data-artboard] { position: relative; overflow: hidden; }
  </style>
</head>
<body>
  <main data-artboard style="width:${o.width}px;height:${o.height}px">
    <img data-layer="canvas" data-type="image" data-role="background" src="${esc(o.src)}" alt="${esc(o.text.slice(0, 1000))}" style="position:absolute;left:0;top:0;width:${o.width}px;height:${o.height}px">
  </main>
</body>
</html>`;
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
  if (!html || !/<meta name="studio:editor" content="wecra">/.test(html))
    return { canvas: false, sourceVersion: null };
  const n = /<meta name="studio:source-version" content="(\d+)">/.exec(html)?.[1];
  return { canvas: true, sourceVersion: n ? Number(n) : null };
}
