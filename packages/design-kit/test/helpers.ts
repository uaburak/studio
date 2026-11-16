import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BrandTokens, generateBrandCss, parseBrandTokens } from "../src/brand/index.ts";
import { createSlideHtml } from "../src/document/index.ts";

export const FIXTURES = new URL("./fixtures/", import.meta.url);
export const fixturePath = (rel: string) => fileURLToPath(new URL(rel, FIXTURES));

export function slide(name: string): string {
  return readFileSync(new URL(`slides/${name}.html`, FIXTURES), "utf8");
}

export const SLIDE_NAMES = readdirSync(new URL("slides/", FIXTURES))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

/** The spike's final (critique-and-revise) outputs, all 1080x1350. */
export const FINAL_SLIDES = [
  "product-intro",
  "typographic",
  "carousel-1",
  "carousel-2",
  "carousel-3",
  "image-slot",
] as const;

export function ventaBrandJson(): unknown {
  return JSON.parse(readFileSync(new URL("venta/brand.json", FIXTURES), "utf8"));
}

export function ventaTokens(): BrandTokens {
  return parseBrandTokens(ventaBrandJson());
}

export function ventaFacts(): { allowedNumbers: string[] } {
  return JSON.parse(readFileSync(new URL("venta/facts.json", FIXTURES), "utf8"));
}

let css: string | null = null;
export function ventaCss(): string {
  css ??= generateBrandCss(ventaTokens()).css;
  return css;
}

/** A contract v1 document with the given design CSS and layers (1080x1350 unless set). */
export function doc(body: string, css = "", size = { width: 1080, height: 1350 }): string {
  return createSlideHtml({ ...size, css, body });
}
