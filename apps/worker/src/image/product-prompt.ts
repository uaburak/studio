/**
 * The image prompt of a product picture (docs/URETIM-RESIM.md §8): the request, the optional
 * style, and the products' exact descriptions word for word, under one rule — the model changes
 * only framing, environment, ambience, light and quality, never the product.
 */
import type { BrandProduct } from "@studio/contract";
import { formatProductDescription, type ReferenceDescription } from "./product-description.ts";

export type ProductPromptMode = "scene" | "upgrade";

export interface PromptProduct {
  product: Pick<BrandProduct, "name" | "category" | "description">;
  descriptions: readonly ReferenceDescription[];
}

/**
 * The style for this picture: the request's own (`""` = none at all), else the brand's preset.
 */
export function resolveStyle(requestStyle: string | undefined, brandPreset: string | undefined) {
  if (requestStyle !== undefined) return requestStyle.trim();
  return (brandPreset ?? "").trim();
}

export const PRODUCT_RULE =
  "THE PRODUCT IS FIXED. Reproduce every product exactly as in its reference photos and the exact description below: the same label text (every word, letter, Turkish character, number, symbol, line break and their order), the same logo, colours, patterns, materials and textures, the same container shape and proportions, the same cap / closure, the same transparency and fill level. Do not add, remove, redraw, translate, restyle, simplify or 'improve' anything on the product. No extra text, labels, stickers or products.";

export const ALLOWED_CHANGES =
  "YOU MAY CHANGE ONLY: the framing (camera position and angle, crop, distance), the environment / setting, the ambience, the light, and the overall photographic quality.";

const UPGRADE_SCENE =
  "A professional e-commerce packshot of the same product: clean seamless pure white studio background (#FFFFFF), professional studio lighting (soft key light, gentle fill, subtle natural contact shadow), the product centred and upright, the same viewing angle as its reference photo, tack-sharp focus edge to edge, high resolution, perfect fine details, true-to-life colours, no props.";

const MAX_PROMPT_CHARS = 14_000;

export function buildProductImagePrompt(input: {
  request: string;
  mode: ProductPromptMode;
  products: readonly PromptProduct[];
  style: string;
  aspectRatio: string;
}): string {
  const scene =
    input.mode === "upgrade"
      ? [UPGRADE_SCENE, input.request.trim() ? `Owner's notes: ${input.request.trim()}` : ""]
          .filter(Boolean)
          .join("\n")
      : input.request.trim();
  const style = input.style.trim()
    ? `STYLE: ${input.style.trim()} — apply it to the setting, light and colour grading only, never to the product.`
    : "";
  const products = input.products
    .map((p, i) => formatProductDescription(p.product, p.descriptions, i + 1))
    .join("\n\n");
  const text = [
    "You are a professional product photographer. Photograph the real product(s) shown in the reference photos.",
    PRODUCT_RULE,
    ALLOWED_CHANGES,
    `${input.mode === "upgrade" ? "SHOT" : "SCENE REQUEST"}: ${scene}`,
    style,
    `Aspect ratio: ${input.aspectRatio}. Photorealistic, no illustration.`,
    "EXACT PRODUCT DESCRIPTION (follow it word for word):",
    products,
  ]
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text;
}

/** A picture without products: the request plus the style (if any). */
export function withStyle(prompt: string, style: string): string {
  return style.trim()
    ? `${prompt.trim()}\n\nStyle: ${style.trim()} (setting, light and colour grading).`
    : prompt;
}
