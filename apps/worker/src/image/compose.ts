/**
 * Label-preserving product composites (U9): the AI draws only the scene; the real product photo
 * is cut out and placed on it pixel for pixel, so the label cannot change. Honest compositing:
 * the product is scaled uniformly and pasted upright (no perspective warp, no repainting); only a
 * gentle brightness / colour-temperature match and a contact shadow tie it to the scene.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProductPosition } from "@studio/contract";
import sharp from "sharp";
import type { Logger } from "../log.ts";
import {
  type Box,
  type SaliencyResult,
  VISION_HELPER_MISSING,
  type VisionHelper,
  VisionHelperError,
} from "../vision/helper.ts";

export type PlacedPosition = Exclude<ProductPosition, "auto">;

export interface ProductCutout {
  png: Uint8Array;
  width: number;
  height: number;
  /** vision: Vision's foreground mask; flat_background: corner-colour flood fill; none: the whole photo. */
  method: "vision" | "flat_background" | "none";
  /** The product's box on the reference (normalized, top-left), when known. */
  box: Box | null;
  /** Turkish, when the cutout is not what it should be. */
  note: string | null;
}

export interface Placement {
  position: PlacedPosition;
  /** Chosen from the scene's saliency (no position was asked for). */
  auto: boolean;
  /** Product height / picture height. */
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LightMatch {
  brightness: number;
  red: number;
  green: number;
  blue: number;
}

export const DEFAULT_PRODUCT_SCALE = 0.62;

const POSITION_WORDS: Record<PlacedPosition, string> = {
  center: "in the center of the frame",
  "bottom-center": "in the lower center of the frame (foreground)",
  "bottom-left": "in the lower left third of the frame (foreground)",
  "bottom-right": "in the lower right third of the frame (foreground)",
  left: "in the left third of the frame, vertically centered",
  right: "in the right third of the frame, vertically centered",
};

export const POSITION_LABELS_TR: Record<PlacedPosition, string> = {
  center: "ortada",
  "bottom-center": "alt ortada",
  "bottom-left": "sol altta",
  "bottom-right": "sağ altta",
  left: "solda",
  right: "sağda",
};

/** The scene prompt: an empty resting place for the product, no product, no text. */
export function buildLabelPreservingScenePrompt(
  userPrompt: string,
  aspectRatio: string,
  options: { position?: PlacedPosition; scale?: number; labelLines?: readonly string[] } = {},
): string {
  const position = options.position ?? "bottom-center";
  const pct = Math.round((options.scale ?? DEFAULT_PRODUCT_SCALE) * 100);
  const label = (options.labelLines ?? []).filter((l) => l.trim()).slice(0, 12);
  return [
    "Create a professional commercial product photography background scene.",
    `SCENE BRIEF: ${userPrompt}`,
    "COMPOSITION FOR PRODUCT COMPOSITING:",
    "- The real product photo (Reference Image 1) is placed into this scene afterwards by software. Use Reference Image 1 only to match the color harmony, lighting temperature, and scale.",
    `- Leave a clean, unobstructed hero resting surface ${POSITION_WORDS[position]}, about ${pct}% of the frame height tall: it is the placeholder where the physical product will be composited. Keep it plain: no props, no objects, no text there.`,
    "- Natural shallow depth of field (85mm f/2.8 commercial lens look), realistic ambient light, soft natural shadows on the resting surface.",
    ...(label.length > 0
      ? [
          `- For context only (do NOT render it): the product's label reads ${label.map((l) => `"${l}"`).join(" / ")}.`,
        ]
      : []),
    "- CRITICAL: Do NOT draw any product pouch, bottle, box, packaging, label, text, letters, numbers, logos, or watermarks anywhere in the scene.",
    `Aspect ratio: ${aspectRatio}.`,
  ].join("\n");
}

// --- the cutout --------------------------------------------------------------------------------

/**
 * Corner-colour flood fill for a packshot on a plain studio backdrop (the old method; the
 * fallback when Vision is missing or finds no foreground). Interior white stays: only backdrop
 * pixels connected to the border go transparent.
 */
export async function extractProductCutout(
  refBytes: Uint8Array,
): Promise<{ png: Uint8Array; width: number; height: number; removedBackground: boolean }> {
  const { data, info } = await sharp(refBytes, { animated: false })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const idxOf = (x: number, y: number) => (y * w + x) * 4;
  const corners = [
    idxOf(0, 0),
    idxOf(Math.max(0, w - 1), 0),
    idxOf(0, Math.max(0, h - 1)),
    idxOf(Math.max(0, w - 1), Math.max(0, h - 1)),
  ];
  const alreadyTransparent = corners.some((c) => (pixels[c + 3] ?? 255) < 200);
  let removed = alreadyTransparent;

  if (!alreadyTransparent && w >= 8 && h >= 8) {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (const c of corners) {
      rSum += pixels[c] ?? 255;
      gSum += pixels[c + 1] ?? 255;
      bSum += pixels[c + 2] ?? 255;
    }
    const bgR = rSum / 4;
    const bgG = gSum / 4;
    const bgB = bSum / 4;
    const colorDist = (offset: number) => {
      const dr = (pixels[offset] ?? 0) - bgR;
      const dg = (pixels[offset + 1] ?? 0) - bgG;
      const db = (pixels[offset + 2] ?? 0) - bgB;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    if (corners.every((c) => colorDist(c) <= 32)) {
      const visited = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      const threshold = 26;
      const trySeed = (x: number, y: number) => {
        const p = y * w + x;
        if (visited[p]) return;
        if (colorDist(p * 4) <= threshold) {
          visited[p] = 1;
          queue[tail++] = p;
        }
      };
      for (let x = 0; x < w; x++) {
        trySeed(x, 0);
        trySeed(x, h - 1);
      }
      for (let y = 0; y < h; y++) {
        trySeed(0, y);
        trySeed(w - 1, y);
      }
      while (head < tail) {
        const cur = queue[head++] as number;
        pixels[cur * 4 + 3] = 0;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0) trySeed(cx - 1, cy);
        if (cx + 1 < w) trySeed(cx + 1, cy);
        if (cy > 0) trySeed(cx, cy - 1);
        if (cy + 1 < h) trySeed(cx, cy + 1);
      }
      // Soften the 1 px silhouette edge.
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (visited[p]) continue;
          const n =
            (visited[p - 1] ?? 0) +
            (visited[p + 1] ?? 0) +
            (visited[p - w] ?? 0) +
            (visited[p + w] ?? 0);
          if (n > 0) pixels[p * 4 + 3] = Math.round((pixels[p * 4 + 3] ?? 255) * (1 - n * 0.12));
        }
      }
      removed = tail > 0;
    }
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((pixels[(y * w + x) * 4 + 3] ?? 0) > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    const orig = await sharp(refBytes, { animated: false })
      .rotate()
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      png: new Uint8Array(orig.data.buffer, orig.data.byteOffset, orig.data.byteLength),
      width: orig.info.width,
      height: orig.info.height,
      removedBackground: false,
    };
  }
  const cropped = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    png: new Uint8Array(cropped.data.buffer, cropped.data.byteOffset, cropped.data.byteLength),
    width: cropped.info.width,
    height: cropped.info.height,
    removedBackground: removed,
  };
}

export interface ComposeDeps {
  vision: VisionHelper;
  stateDir: string;
  logger: Logger;
}

/** A temp folder for helper input / output files, removed by the caller. */
export async function visionWorkDir(stateDir: string): Promise<string> {
  const dir = path.join(stateDir, "vision-tmp", randomUUID());
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The reference as an upright PNG file for Vision (EXIF applied, same pixels otherwise). */
export async function writeUpright(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, await sharp(bytes, { animated: false }).rotate().png().toBuffer());
  return file;
}

/**
 * Cut the product out of its photo: Vision's foreground mask (works on lifestyle and busy
 * backgrounds), else the plain-backdrop flood fill, else the whole photo (with a note).
 */
export async function cutoutProduct(
  deps: ComposeDeps,
  refFile: string,
  refBytes: Uint8Array,
  workDir: string,
  signal?: AbortSignal,
): Promise<ProductCutout> {
  let visionNote: string | null = null;
  if (await deps.vision.available()) {
    const out = path.join(workDir, "cutout.png");
    try {
      const mask = await deps.vision.foregroundMask(refFile, out, {
        instances: "all",
        ...(signal ? { signal } : {}),
      });
      const png = new Uint8Array(await readFile(out));
      return {
        png,
        width: mask.width,
        height: mask.height,
        method: "vision",
        box: mask.box,
        note:
          mask.coverage > 0.92
            ? "Vision ürünü arka plandan pek ayıramadı (neredeyse tüm fotoğraf ürün sayıldı)."
            : null,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      visionNote =
        error instanceof VisionHelperError && error.code === "no_foreground"
          ? "Vision fotoğrafta ayrılabilir bir ürün bulamadı."
          : `Vision ile arka plan ayrılamadı (${(error as Error).message}).`;
      deps.logger.warn(`product cutout with Vision failed: ${(error as Error).message}`);
    }
  } else {
    visionNote = `Arka plan ayırma için ${VISION_HELPER_MISSING}`;
  }
  const flat = await extractProductCutout(refBytes);
  if (flat.removedBackground) {
    return {
      png: flat.png,
      width: flat.width,
      height: flat.height,
      method: "flat_background",
      box: null,
      note: `${visionNote ?? ""} Düz arka plan yöntemi kullanıldı.`.trim(),
    };
  }
  return {
    png: flat.png,
    width: flat.width,
    height: flat.height,
    method: "none",
    box: null,
    note: `${visionNote ?? ""} Ürün arka planından ayrılamadı; fotoğrafın tamamı dikdörtgen olarak yerleştirildi. Düz arka planlı bir ürün fotoğrafı daha iyi sonuç verir.`.trim(),
  };
}

// --- placement -----------------------------------------------------------------------------------

/** Where the product goes for a position and scale (kept inside a 2 % margin, never warped). */
export function placementRect(
  sceneW: number,
  sceneH: number,
  cutW: number,
  cutH: number,
  position: PlacedPosition,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const margin = Math.round(Math.min(sceneW, sceneH) * 0.02);
  let height = Math.max(16, Math.round(sceneH * scale));
  let width = Math.max(16, Math.round((height * cutW) / Math.max(1, cutH)));
  const maxW = Math.round(sceneW * 0.85);
  if (width > maxW) {
    width = maxW;
    height = Math.max(16, Math.round((width * cutH) / Math.max(1, cutW)));
  }
  height = Math.min(height, sceneH - 2 * margin);
  width = Math.min(width, sceneW - 2 * margin);
  const cx =
    position === "bottom-left" || position === "left"
      ? sceneW * 0.3
      : position === "bottom-right" || position === "right"
        ? sceneW * 0.7
        : sceneW * 0.5;
  const bottomAnchored = position.startsWith("bottom");
  let left = Math.round(cx - width / 2);
  let top = bottomAnchored
    ? Math.round(sceneH * 0.94 - height)
    : Math.round(sceneH * 0.52 - height / 2);
  left = Math.max(margin, Math.min(sceneW - margin - width, left));
  top = Math.max(margin, Math.min(sceneH - margin - height, top));
  return { left, top, width, height };
}

/** Mean saliency over a rectangle (grid cells weighted by overlap). */
export function meanSaliency(
  grid: SaliencyResult,
  sceneW: number,
  sceneH: number,
  rect: { left: number; top: number; width: number; height: number },
): number {
  const cw = sceneW / grid.columns;
  const ch = sceneH / grid.rows;
  let sum = 0;
  let weight = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.columns; c++) {
      const x0 = Math.max(rect.left, c * cw);
      const x1 = Math.min(rect.left + rect.width, (c + 1) * cw);
      const y0 = Math.max(rect.top, r * ch);
      const y1 = Math.min(rect.top + rect.height, (r + 1) * ch);
      if (x1 <= x0 || y1 <= y0) continue;
      const area = (x1 - x0) * (y1 - y0);
      sum += (grid.grid[r * grid.columns + c] ?? 0) * area;
      weight += area;
    }
  }
  return weight > 0 ? sum / weight : 0;
}

const AUTO_CANDIDATES: { position: PlacedPosition; bias: number }[] = [
  // The scene prompt asked for an empty surface in the lower centre.
  { position: "bottom-center", bias: -0.08 },
  { position: "bottom-left", bias: 0 },
  { position: "bottom-right", bias: 0 },
  { position: "center", bias: 0.04 },
];

/** The emptiest usual spot (least attention-grabbing scene there), lower centre on ties. */
export function chooseAutoPosition(
  grid: SaliencyResult | null,
  sceneW: number,
  sceneH: number,
  cutW: number,
  cutH: number,
  scale: number,
): PlacedPosition {
  if (!grid || grid.grid.length !== grid.columns * grid.rows) return "bottom-center";
  let best: { position: PlacedPosition; score: number } | null = null;
  for (const candidate of AUTO_CANDIDATES) {
    const rect = placementRect(sceneW, sceneH, cutW, cutH, candidate.position, scale);
    const score = meanSaliency(grid, sceneW, sceneH, rect) + candidate.bias;
    if (!best || score < best.score) best = { position: candidate.position, score };
  }
  return best?.position ?? "bottom-center";
}

// --- light and shadow ------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Gentle gains that pull the product toward the scene's brightness and colour temperature around
 * where it stands. Small on purpose (±10 % brightness, ±5 % per channel): the label must stay as
 * printed.
 */
export function lightGains(
  scene: { r: number; g: number; b: number },
  product: { r: number; g: number; b: number },
): LightMatch {
  const ys = luma(scene.r, scene.g, scene.b);
  const yp = luma(product.r, product.g, product.b);
  if (ys < 1 || yp < 1) return { brightness: 1, red: 1, green: 1, blue: 1 };
  const brightness = clamp((ys / yp) ** 0.2, 0.9, 1.08);
  const channel = (s: number, p: number) =>
    clamp((s / ys / Math.max(0.01, p / yp)) ** 0.15, 0.95, 1.05);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    brightness: round(brightness),
    red: round(channel(scene.r, product.r)),
    green: round(channel(scene.g, product.g)),
    blue: round(channel(scene.b, product.b)),
  };
}

export interface CompositeResult {
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
  light: LightMatch;
}

/** Put the product on the scene at `rect`: contact + soft drop shadow, light match, pixels as-is. */
export async function compositeProduct(
  sceneBytes: Uint8Array,
  cutout: Pick<ProductCutout, "png">,
  rect: { left: number; top: number; width: number; height: number },
  options: { matchLight?: boolean } = {},
): Promise<CompositeResult> {
  const scene = sharp(sceneBytes, { animated: false }).rotate();
  const meta = await scene.metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const sceneW = (rotated ? meta.height : meta.width) ?? 1080;
  const sceneH = (rotated ? meta.width : meta.height) ?? 1350;

  const product = await sharp(cutout.png)
    .resize({ width: rect.width, height: rect.height, fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pw = product.info.width;
  const ph = product.info.height;
  const px = new Uint8Array(product.data.buffer, product.data.byteOffset, product.data.byteLength);

  // Light match: the scene around the product vs the product itself (alpha-weighted).
  let light: LightMatch = { brightness: 1, red: 1, green: 1, blue: 1 };
  if (options.matchLight !== false) {
    const padX = Math.round(rect.width * 0.25);
    const padY = Math.round(rect.height * 0.25);
    const region = {
      left: clamp(rect.left - padX, 0, sceneW - 1),
      top: clamp(rect.top - padY, 0, sceneH - 1),
      width: 0,
      height: 0,
    };
    region.width = clamp(rect.width + 2 * padX, 1, sceneW - region.left);
    region.height = clamp(rect.height + 2 * padY, 1, sceneH - region.top);
    const stats = await sharp(sceneBytes, { animated: false }).rotate().extract(region).stats();
    const sceneMean = {
      r: stats.channels[0]?.mean ?? 128,
      g: stats.channels[1]?.mean ?? 128,
      b: stats.channels[2]?.mean ?? 128,
    };
    let wsum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < pw * ph; i++) {
      const a = (px[i * 4 + 3] ?? 0) / 255;
      if (a <= 0) continue;
      wsum += a;
      r += (px[i * 4] ?? 0) * a;
      g += (px[i * 4 + 1] ?? 0) * a;
      b += (px[i * 4 + 2] ?? 0) * a;
    }
    if (wsum > 0) {
      light = lightGains(sceneMean, { r: r / wsum, g: g / wsum, b: b / wsum });
      const gr = light.brightness * light.red;
      const gg = light.brightness * light.green;
      const gb = light.brightness * light.blue;
      for (let i = 0; i < pw * ph; i++) {
        px[i * 4] = clamp(Math.round((px[i * 4] ?? 0) * gr), 0, 255);
        px[i * 4 + 1] = clamp(Math.round((px[i * 4 + 1] ?? 0) * gg), 0, 255);
        px[i * 4 + 2] = clamp(Math.round((px[i * 4 + 2] ?? 0) * gb), 0, 255);
      }
    }
  }
  const productPng = await sharp(px, { raw: { width: pw, height: ph, channels: 4 } })
    .png()
    .toBuffer();

  // Shadows on a scene-sized layer: an elliptical contact shadow where the product stands and a
  // faint silhouette drop shadow, both blurred.
  const contactW = Math.round(pw * 0.9);
  const contactH = Math.max(6, Math.round(ph * 0.06));
  const cx = rect.left + pw / 2;
  const cy = Math.min(sceneH - 1, rect.top + ph - contactH * 0.15);
  const ellipse = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sceneW}" height="${sceneH}"><ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(contactW / 2).toFixed(1)}" ry="${(contactH / 2).toFixed(1)}" fill="black" fill-opacity="0.42"/></svg>`,
  );
  const silhouette = Buffer.alloc(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) silhouette[i * 4 + 3] = Math.round((px[i * 4 + 3] ?? 0) * 0.22);
  const silhouettePng = await sharp(silhouette, { raw: { width: pw, height: ph, channels: 4 } })
    .png()
    .toBuffer();
  const offX = Math.round(pw * 0.012);
  const offY = Math.round(ph * 0.015);
  const shadowLeft = clamp(rect.left + offX, 0, Math.max(0, sceneW - pw));
  const shadowTop = clamp(rect.top + offY, 0, Math.max(0, sceneH - ph));
  const shadowLayer = await sharp({
    create: {
      width: sceneW,
      height: sceneH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: ellipse, left: 0, top: 0 },
      { input: silhouettePng, left: shadowLeft, top: shadowTop },
    ])
    .png()
    .toBuffer();
  const blurred = await sharp(shadowLayer)
    .blur(Math.max(1.5, Math.min(40, Math.min(pw, ph) * 0.025)))
    .png()
    .toBuffer();

  const out = await sharp(sceneBytes, { animated: false })
    .rotate()
    .ensureAlpha()
    .composite([
      { input: blurred, left: 0, top: 0 },
      { input: productPng, left: rect.left, top: rect.top },
    ])
    .toColorspace("srgb")
    .png({ compressionLevel: 8 })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
    mimeType: "image/png",
    width: out.info.width,
    height: out.info.height,
    light,
  };
}

/** The product's area of a picture (with a small margin) as a PNG file, for OCR. */
export async function writeRegion(
  dir: string,
  name: string,
  bytes: Uint8Array,
  rect: { left: number; top: number; width: number; height: number },
): Promise<string> {
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const padX = Math.round(rect.width * 0.03);
  const padY = Math.round(rect.height * 0.03);
  const left = clamp(rect.left - padX, 0, Math.max(0, w - 1));
  const top = clamp(rect.top - padY, 0, Math.max(0, h - 1));
  const width = clamp(rect.width + 2 * padX, 1, w - left);
  const height = clamp(rect.height + 2 * padY, 1, h - top);
  const file = path.join(dir, name);
  await writeFile(
    file,
    await sharp(bytes)
      .extract({ left, top, width, height })
      .png({ compressionLevel: 3 })
      .toBuffer(),
  );
  return file;
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
