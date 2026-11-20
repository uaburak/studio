/** A decoded picture (kept apart from the in-page code, so non-DOM packages can import it). */
export interface Raster {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) */
  channels: number;
  data: Uint8Array | Uint8ClampedArray;
}
