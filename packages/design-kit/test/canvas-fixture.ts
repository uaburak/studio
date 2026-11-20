// A canvas slide as the desktop's extractor writes its facts (a Wecra frame: a headline, a body
// text, an empty image slot, the brand logo and a picture added on the canvas), and a render of
// it: the background with the texts' "ink" (glyph-like bars in the text colour), the logo and the
// picture — what Wecra's engine would export for those facts.
import type { CanvasFacts, CanvasNode, CanvasText } from "../src/canvas/facts.ts";
import type { Raster } from "../src/lint/raster.ts";

export const W = 1080;
export const H = 1350;
export const BG = "#F4EFE4";
export const INK = "#1D2A1B";

const node = (o: Partial<CanvasNode> & Pick<CanvasNode, "id" | "name" | "type">): CanvasNode => ({
  wecraType: o.type === "text" ? "TEXT" : "FRAME",
  parent: null,
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  rotation: 0,
  opacity: 1,
  effectiveOpacity: 1,
  visible: true,
  clips: false,
  clip: null,
  fills: [],
  strokes: [],
  strokeWeight: 0,
  mark: null,
  ...o,
});

export function textOf(o: Partial<CanvasText> & Pick<CanvasText, "characters">): CanvasText {
  return {
    family: "Archivo",
    style: "Bold",
    weight: 700,
    italic: false,
    size: 40,
    lineHeight: 48,
    letterSpacing: 0,
    align: "left",
    verticalAlign: "top",
    autoResize: "height",
    color: INK,
    colors: [o.color ?? INK],
    fills: [{ type: "solid", color: o.color ?? INK, opacity: 1 }],
    runs: [],
    lines: [],
    overflow: false,
    truncated: false,
    missingFont: false,
    ...o,
  };
}

export function canvasFacts(change: (nodes: CanvasNode[]) => CanvasNode[] = (n) => n): CanvasFacts {
  const nodes: CanvasNode[] = [
    node({
      id: "7:2",
      name: "headline",
      type: "text",
      bounds: { x: 80, y: 200, w: 600, h: 96 },
      text: textOf({
        characters: "Hasat bitti",
        family: "Archivo",
        style: "Extra Bold",
        weight: 800,
        size: 80,
        lineHeight: 96,
        lines: [{ x: 80, y: 200, w: 420, h: 96, from: 0, to: 11 }],
      }),
      mark: {
        layer: "headline",
        type: "text",
        role: "headline",
        src: null,
        image: null,
        allowOverlap: false,
        slot: null,
      },
    }),
    node({
      id: "7:3",
      name: "Toprağınız için bor ve çinko",
      type: "text",
      bounds: { x: 80, y: 1000, w: 700, h: 88 },
      text: textOf({
        characters: "Toprağınız için bor\nve çinko.",
        family: "Montserrat",
        style: "Medium",
        weight: 500,
        size: 36,
        lineHeight: 44,
        lines: [
          { x: 80, y: 1000, w: 380, h: 44, from: 0, to: 20 },
          { x: 80, y: 1044, w: 200, h: 44, from: 20, to: 29 },
        ],
      }),
    }),
    node({
      id: "7:4",
      name: "field-photo",
      type: "frame",
      bounds: { x: 560, y: 320, w: 400, h: 500 },
      clips: true,
      fills: [{ type: "solid", color: "#E0D9C8", opacity: 1 }],
      mark: {
        layer: "field-photo",
        type: "slot",
        role: null,
        src: null,
        image: null,
        allowOverlap: false,
        slot: { ratio: "4:5", label: "Saha fotoğrafı", fit: "cover" },
      },
    }),
    node({
      id: "7:5",
      name: "logo",
      type: "image",
      wecraType: "ROUNDED_RECTANGLE",
      bounds: { x: 80, y: 1180, w: 240, h: 80 },
      fills: [
        {
          type: "image",
          image: "a".repeat(40),
          fit: "fit",
          size: { w: 480, h: 160 },
          opacity: 1,
        },
      ],
      mark: {
        layer: "logo",
        type: "logo",
        role: null,
        src: "/brand/logos/venta-wordmark-black.standin.png",
        image: "a".repeat(40),
        allowOverlap: false,
        slot: null,
      },
    }),
    node({
      id: "7:6",
      name: "Fotoğraf",
      type: "image",
      wecraType: "ROUNDED_RECTANGLE",
      bounds: { x: 600, y: 900, w: 300, h: 200 },
      fills: [
        { type: "image", image: "b".repeat(40), fit: "fill", size: { w: 600, h: 400 }, opacity: 1 },
      ],
    }),
  ];
  return {
    v: 1,
    editor: "wecra",
    frame: {
      id: "7:1",
      name: "Kare 1",
      width: W,
      height: H,
      background: BG,
      fills: [{ type: "solid", color: BG, opacity: 1 }],
    },
    nodes: change(nodes),
    fonts: [
      { family: "Archivo", style: "Extra Bold", uses: 1, missing: false },
      { family: "Montserrat", style: "Medium", uses: 1, missing: false },
    ],
  };
}

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** The render of `facts`: the frame's colour, solid fills, pictures as noise, texts as ink bars. */
export function renderFacts(facts: CanvasFacts): Raster {
  const data = new Uint8Array(W * H * 3);
  const fill = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    c: (x: number, y: number) => readonly number[] | null,
  ) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y0 + h)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x0 + w)); x++) {
        const v = c(x, y);
        if (!v) continue;
        const i = (y * W + x) * 3;
        data[i] = v[0] as number;
        data[i + 1] = v[1] as number;
        data[i + 2] = v[2] as number;
      }
  };
  const bg = rgb(facts.frame.background ?? "#FFFFFF");
  fill(0, 0, W, H, () => bg);
  for (const n of facts.nodes) {
    if (!n.visible) continue;
    const b = n.bounds;
    for (const p of n.fills) {
      if (p.type === "solid") fill(b.x, b.y, b.w, b.h, () => rgb(p.color));
      if (p.type === "image")
        fill(b.x, b.y, b.w, b.h, (x, y) => [
          (x * 7 + y * 3) % 200,
          ((x * 3 + y * 5) % 160) + 40,
          90,
        ]);
    }
    if (n.text?.color) {
      const ink = rgb(n.text.color);
      // Glyph-like bars: 60% of each line's middle band, in strokes.
      for (const l of n.text.lines)
        fill(l.x, l.y + l.h * 0.2, l.w, l.h * 0.6, (x) =>
          (x - Math.round(l.x)) % 14 < 7 ? ink : null,
        );
    }
  }
  return { width: W, height: H, channels: 3, data };
}
