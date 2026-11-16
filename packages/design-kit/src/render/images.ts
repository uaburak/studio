import sharp from "sharp";
import type { Raster } from "../lint/contrast.ts";

/** Chromium PNG (sRGB pixels, `--force-color-profile=srgb`) to a tagged sRGB JPEG. */
export async function pngToSrgbJpeg(png: Uint8Array, quality = 92): Promise<Uint8Array> {
  const out = await sharp(png)
    .toColorspace("srgb")
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .withIccProfile("srgb")
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Decode a PNG to raw RGB for pixel checks. */
export async function decodePng(png: Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

export interface ImageInfo {
  format: string;
  width: number;
  height: number;
  space: string;
  hasIcc: boolean;
  bytes: number;
}

export async function imageInfo(bytes: Uint8Array): Promise<ImageInfo> {
  const m = await sharp(bytes).metadata();
  return {
    format: m.format ?? "unknown",
    width: m.width ?? 0,
    height: m.height ?? 0,
    space: m.space ?? "unknown",
    hasIcc: Boolean(m.icc),
    bytes: bytes.byteLength,
  };
}
