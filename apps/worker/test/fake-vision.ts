/**
 * A stand-in for `studio-vision` (apps/vision-helper) in unit tests: deterministic answers by
 * file name, so the U9 pipeline and the tagging job run without Apple's Vision. The real helper
 * is exercised by the `*.vision.test.ts` cases when it is built.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  AnalyzeResult,
  Box,
  MaskResult,
  OcrLine,
  OcrResult,
  SaliencyResult,
  VisionHelper,
} from "../src/vision/helper.ts";
import { VisionHelperError } from "../src/vision/helper.ts";

export interface FakeVisionOptions {
  /** The product's box on the reference (normalized); the mask cuts this rectangle out. */
  productBox?: Box;
  /** OCR answers by file name prefix: `reference`, `final-product`, `scene`, else `other`. */
  ocr?: Partial<Record<"reference" | "final-product" | "scene" | "generated" | "other", OcrLine[]>>;
  saliency?: SaliencyResult;
  analyze?: AnalyzeResult;
  /** foreground-mask fails with this code. */
  maskError?: string;
}

export interface FakeVision extends VisionHelper {
  calls: { command: string; file: string }[];
}

function ocrResult(lines: OcrLine[]): OcrResult {
  return {
    languages: ["tr-TR", "en-US"],
    unsupportedLanguages: [],
    lines,
    text: lines.map((l) => l.text).join("\n"),
  };
}

export function line(text: string, box: Box, confidence = 0.95): OcrLine {
  return { text, confidence, box };
}

export function fakeVision(options: FakeVisionOptions = {}): FakeVision {
  const calls: { command: string; file: string }[] = [];
  const which = (file: string): "reference" | "final-product" | "scene" | "generated" | "other" => {
    const name = path.basename(file);
    if (name.startsWith("generated")) return "generated";
    if (name.startsWith("reference")) return "reference";
    if (name.startsWith("final-product")) return "final-product";
    if (name.startsWith("scene")) return "scene";
    return "other";
  };
  const helper: FakeVision = {
    bin: "/fake/studio-vision",
    calls,
    available: async () => true,
    info: async () => ({
      helperVersion: "fake",
      os: "macOS",
      ocrLanguages: ["tr-TR", "en-US"],
      foregroundMask: true,
      featurePrintRevision: 2,
    }),
    run: async () => {
      throw new Error("not used");
    },
    ocr: async (file) => {
      calls.push({ command: "ocr", file });
      return ocrResult(options.ocr?.[which(file)] ?? []);
    },
    classify: async (file) => {
      calls.push({ command: "classify", file });
      return { labels: options.analyze?.classify?.labels ?? [] };
    },
    featurePrint: async (file) => {
      calls.push({ command: "feature-print", file });
      return options.analyze?.featurePrint ?? { revision: 2, count: 1, data: "AACAPw==" };
    },
    foregroundMask: async (file, output): Promise<MaskResult> => {
      calls.push({ command: "foreground-mask", file });
      if (options.maskError) throw new VisionHelperError(options.maskError, "fake mask failure");
      const box = options.productBox ?? { x: 0.25, y: 0.2, width: 0.5, height: 0.6 };
      const meta = await sharp(file).metadata();
      const w = meta.width ?? 1;
      const h = meta.height ?? 1;
      const rect = {
        left: Math.round(box.x * w),
        top: Math.round(box.y * h),
        width: Math.round(box.width * w),
        height: Math.round(box.height * h),
      };
      const png = await sharp(file).extract(rect).ensureAlpha().png().toBuffer();
      await writeFile(output, png);
      return {
        instances: [{ instance: 1, area: box.width * box.height }],
        used: [1],
        box,
        pixelBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        coverage: box.width * box.height,
        width: rect.width,
        height: rect.height,
        output,
        png: null,
      };
    },
    saliency: async (file) => {
      calls.push({ command: "saliency", file });
      return (
        options.saliency ?? {
          objects: [],
          columns: 2,
          rows: 2,
          grid: [1, 1, 0, 0],
        }
      );
    },
    analyze: async (file, ops) => {
      calls.push({ command: `analyze:${ops.join(",")}`, file });
      return { result: options.analyze ?? { errors: {} }, helperVersion: "fake" };
    },
  };
  return helper;
}
