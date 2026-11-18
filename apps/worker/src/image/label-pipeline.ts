/**
 * U9: the label-preserving product picture, step by step (method of
 * `.claude/skills/product-reference-image/SKILL.md`, with the real product composited instead of
 * redrawn):
 *
 * 1. Read the label first: the owner's `labelText`, else Vision OCR of the reference (only lines
 *    on the product, split into must-match and fine print).
 * 2. Cut the product out: Vision's foreground mask (lifestyle / busy photos too), else the plain
 *    backdrop flood fill, else the whole photo (said so).
 * 3. (the caller) Ask the image model for the scene only: an empty resting place at the wanted
 *    position, the label text verbatim as context, no product, no text.
 * 4. Place it: the requested position / scale, else the emptiest usual spot by Vision saliency.
 * 5. Composite honestly: uniform scale, upright, contact + drop shadow, gentle light match.
 * 6. Verify: OCR the final picture's product area and compare with step 1 (Turkish-aware). A
 *    changed or unreadable label is reported, never passed off as right.
 */
import type { ProductPosition } from "@studio/contract";
import sharp from "sharp";
import type { Logger } from "../log.ts";
import { VISION_HELPER_MISSING, type VisionHelper } from "../vision/helper.ts";
import {
  chooseAutoPosition,
  compositeProduct,
  cutoutProduct,
  DEFAULT_PRODUCT_SCALE,
  type LightMatch,
  type PlacedPosition,
  type Placement,
  POSITION_LABELS_TR,
  type ProductCutout,
  placementRect,
  removeDir,
  visionWorkDir,
  writeRegion,
  writeUpright,
} from "./compose.ts";
import {
  compareLabel,
  expectedFromOwner,
  expectedFromReference,
  type LabelCheck,
  skippedLabelCheck,
} from "./label-check.ts";

export interface LabelPipelineDeps {
  vision: VisionHelper;
  stateDir: string;
  logger: Logger;
}

export interface PreparedProduct {
  cutout: ProductCutout;
  /** Must-match label lines (verbatim) and fine print, from the owner or the reference. */
  expected: string[];
  finePrint: string[];
  source: "owner" | "ocr" | "none";
  notes: string[];
  workDir: string;
}

/** Steps 1–2: read the label and cut the product out (before any paid call). */
export async function prepareProduct(
  deps: LabelPipelineDeps,
  refBytes: Uint8Array,
  labelText: string | undefined,
  signal?: AbortSignal,
): Promise<PreparedProduct> {
  const workDir = await visionWorkDir(deps.stateDir);
  try {
    const refFile = await writeUpright(workDir, "reference.png", refBytes);
    const cutout = await cutoutProduct(deps, refFile, refBytes, workDir, signal);
    const notes: string[] = cutout.note ? [cutout.note] : [];
    let expected: string[] = [];
    let finePrint: string[] = [];
    let source: PreparedProduct["source"] = "none";
    if (labelText?.trim()) {
      expected = expectedFromOwner(labelText);
      source = expected.length > 0 ? "owner" : "none";
    } else if (await deps.vision.available()) {
      try {
        const ocr = await deps.vision.ocr(refFile, signal ? { signal } : {});
        ({ expected, finePrint } = expectedFromReference(ocr.lines, cutout.box));
        source = expected.length > 0 ? "ocr" : "none";
      } catch (error) {
        if (signal?.aborted) throw error;
        notes.push(`Referanstaki etiket okunamadı (${(error as Error).message}).`);
      }
    }
    return { cutout, expected, finePrint, source, notes, workDir };
  } catch (error) {
    await removeDir(workDir);
    throw error;
  }
}

export interface PlacedProduct {
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
  placement: Placement;
  light: LightMatch;
  labelCheck: LabelCheck;
  notes: string[];
}

const IDENTITY: LightMatch = { brightness: 1, red: 1, green: 1, blue: 1 };
const isIdentity = (l: LightMatch) =>
  l.brightness === 1 && l.red === 1 && l.green === 1 && l.blue === 1;

/** Steps 4–6: place on the generated scene, composite, read the label back. */
export async function placeAndVerify(
  deps: LabelPipelineDeps,
  sceneBytes: Uint8Array,
  product: PreparedProduct,
  request: { position?: ProductPosition | undefined; scale?: number | undefined },
  signal?: AbortSignal,
): Promise<PlacedProduct> {
  const notes: string[] = [];
  const meta = await sharp(sceneBytes, { animated: false }).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const sceneW = (rotated ? meta.height : meta.width) ?? 1080;
  const sceneH = (rotated ? meta.width : meta.height) ?? 1350;
  const scale = request.scale ?? DEFAULT_PRODUCT_SCALE;
  const { cutout } = product;
  const helper = await deps.vision.available();
  const runOpts = signal ? { signal } : {};

  // The scene as Vision sees it: saliency for an automatic spot, and stray text.
  let sceneFile: string | null = null;
  if (helper) sceneFile = await writeUpright(product.workDir, "scene.png", sceneBytes);

  let position: PlacedPosition;
  const auto = !request.position || request.position === "auto";
  if (auto) {
    let grid = null;
    if (sceneFile) {
      try {
        grid = await deps.vision.saliency(sceneFile, { columns: 12, rows: 12, ...runOpts });
      } catch (error) {
        if (signal?.aborted) throw error;
        deps.logger.warn(`scene saliency failed: ${(error as Error).message}`);
      }
    }
    position = chooseAutoPosition(grid, sceneW, sceneH, cutout.width, cutout.height, scale);
  } else {
    position = request.position as PlacedPosition;
  }
  const rect = placementRect(sceneW, sceneH, cutout.width, cutout.height, position, scale);
  const placement: Placement = { position, auto, scale, ...rect };
  if (rect.height > cutout.height * 2) {
    notes.push(
      "Referans fotoğraf küçük: ürün iki katından fazla büyütüldü, etiket yumuşamış olabilir. Daha büyük bir ürün fotoğrafı daha net sonuç verir.",
    );
  }

  let composite = await compositeProduct(sceneBytes, cutout, rect, { matchLight: true });

  // Stray text in the scene outside the product (the model drew letters or a fake product).
  if (sceneFile) {
    try {
      const sceneText = await deps.vision.ocr(sceneFile, runOpts);
      const stray = sceneText.lines.filter((l) => {
        if (l.confidence < 0.5) return false;
        const cx = (l.box.x + l.box.width / 2) * sceneW;
        const cy = (l.box.y + l.box.height / 2) * sceneH;
        return (
          cx < rect.left ||
          cx > rect.left + rect.width ||
          cy < rect.top ||
          cy > rect.top + rect.height
        );
      });
      if (stray.length > 0) {
        notes.push(
          `Üretilen sahnede ürün dışında yazı da var (${stray
            .slice(0, 3)
            .map((l) => `“${l.text}”`)
            .join(", ")}); kontrol edin.`,
        );
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      deps.logger.warn(`scene OCR failed: ${(error as Error).message}`);
    }
  }

  // Step 6: read the label back on the final picture.
  let labelCheck: LabelCheck;
  if (!helper) {
    labelCheck = skippedLabelCheck(VISION_HELPER_MISSING);
  } else if (product.expected.length === 0) {
    labelCheck = compareLabel({ expected: [], source: "ocr", found: [] });
  } else {
    const read = async (bytes: Uint8Array, name: string) => {
      const region = await writeRegion(product.workDir, name, bytes, rect);
      const ocr = await deps.vision.ocr(region, runOpts);
      return compareLabel({
        expected: product.expected,
        finePrint: product.finePrint,
        source: product.source === "owner" ? "owner" : "ocr",
        found: ocr.lines.map((l) => l.text),
      });
    };
    try {
      labelCheck = await read(composite.bytes, "final-product.png");
      if (labelCheck.status !== "ok" && !isIdentity(composite.light)) {
        // The light match must never cost legibility: try the untouched pixels.
        const plain = await compositeProduct(sceneBytes, cutout, rect, { matchLight: false });
        const again = await read(plain.bytes, "final-product-plain.png");
        if (again.score > labelCheck.score) {
          composite = { ...plain, light: IDENTITY };
          labelCheck = again;
          notes.push("Işık uyumu etiketin okunurluğunu düşürdüğü için kapatıldı.");
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      labelCheck = skippedLabelCheck(`son görsel okunamadı (${(error as Error).message}).`);
    }
  }

  return {
    bytes: composite.bytes,
    mimeType: composite.mimeType,
    width: composite.width,
    height: composite.height,
    placement,
    light: composite.light,
    labelCheck,
    notes,
  };
}

/** Labels that must not be delivered into a post without the owner looking first. */
export function labelBlocksDelivery(check: { status: string }): boolean {
  return check.status === "mismatch" || check.status === "unreadable";
}

/** One Turkish line for progress / notifications. */
export function placementSummary(placement: Placement): string {
  return `Ürün ${POSITION_LABELS_TR[placement.position]} (${Math.round(placement.scale * 100)}% yükseklik${placement.auto ? ", sahneye göre seçildi" : ""})`;
}
