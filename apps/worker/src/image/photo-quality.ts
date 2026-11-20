/**
 * Is a product photo good enough to work from (docs/URETIM-RESIM.md §13)? Cheap local measures:
 * resolution, sharpness (variance of the Laplacian on a 512 px greyscale copy), brightness and
 * contrast. Noise and bad colour are left to the agent's eyes (`get_product` `withPhotos`).
 */
import sharp from "sharp";

export interface PhotoQuality {
  width: number;
  height: number;
  /** Variance of the Laplacian (higher = sharper). */
  sharpness: number;
  /** Mean luminance 0…255. */
  brightness: number;
  /** Luminance standard deviation 0…128. */
  contrast: number;
  lowQuality: boolean;
  /** Turkish reasons ("düşük çözünürlük (640×480)", "bulanık"). */
  reasons: string[];
}

/** Below these the photo is called low quality. */
export const QUALITY_LIMITS = {
  minLongEdge: 1200,
  minShortEdge: 700,
  minSharpness: 60,
  minBrightness: 55,
  maxBrightness: 245,
  minContrast: 18,
} as const;

const ANALYSIS_EDGE = 512;

export async function assessPhotoQuality(bytes: Uint8Array): Promise<PhotoQuality> {
  const meta = await sharp(bytes, { animated: false }).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;
  const { data, info } = await sharp(bytes, { animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const px = (x: number, y: number) => data[(y * w + x) * ch] as number;

  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px(x, y);
      sum += v;
      sumSq += v * v;
    }
  }
  const n = Math.max(1, w * h);
  const brightness = sum / n;
  const contrast = Math.sqrt(Math.max(0, sumSq / n - brightness * brightness));

  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const lap = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4 * px(x, y);
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const lapMean = count > 0 ? lapSum / count : 0;
  const sharpness = count > 0 ? lapSq / count - lapMean * lapMean : 0;

  const reasons: string[] = [];
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long < QUALITY_LIMITS.minLongEdge || short < QUALITY_LIMITS.minShortEdge) {
    reasons.push(`düşük çözünürlük (${width}×${height})`);
  }
  if (sharpness < QUALITY_LIMITS.minSharpness) reasons.push("bulanık");
  if (brightness < QUALITY_LIMITS.minBrightness) reasons.push("karanlık, ışık yetersiz");
  else if (brightness > QUALITY_LIMITS.maxBrightness && contrast < 30) {
    reasons.push("aşırı pozlanmış");
  }
  if (contrast < QUALITY_LIMITS.minContrast) reasons.push("soluk, kontrast düşük");
  return {
    width,
    height,
    sharpness: Math.round(sharpness * 10) / 10,
    brightness: Math.round(brightness),
    contrast: Math.round(contrast),
    lowQuality: reasons.length > 0,
    reasons,
  };
}
