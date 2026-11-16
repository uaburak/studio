import { BRAND_CSS_PATH } from "../contract/constants.ts";
import type { ArtboardSize } from "../contract/schemas.ts";
import { escapeAttr } from "../html/dom.ts";
import { CONTRACT_VERSION } from "../version.ts";

export interface CreateSlideOptions extends ArtboardSize {
  lang?: string;
  /** Design CSS for the `<style>` block. */
  css?: string;
  /** Layers markup (inside the artboard). */
  body?: string;
}

/** A contract v1 document skeleton (the shape §1 of the contract prescribes). */
export function createSlideHtml(o: CreateSlideOptions): string {
  const css = (o.css ?? "").trim();
  const body = (o.body ?? "").trim();
  return [
    "<!doctype html>",
    `<html lang="${escapeAttr(o.lang ?? "tr")}">`,
    "<head>",
    '  <meta charset="utf-8">',
    `  <meta name="studio:contract" content="${CONTRACT_VERSION}">`,
    `  <meta name="studio:format" content="${o.width}x${o.height}">`,
    `  <link rel="stylesheet" href="${BRAND_CSS_PATH}">`,
    `  <style>${css ? `\n${css.replace(/^/gm, "    ")}\n  ` : ""}</style>`,
    "</head>",
    "<body>",
    `  <main data-artboard style="width:${o.width}px;height:${o.height}px">${body ? `\n${body.replace(/^/gm, "    ")}\n  ` : "\n  "}</main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
