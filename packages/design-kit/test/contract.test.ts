import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  DESIGN_CONTRACT_MD,
  LAYER_ROLES,
  LAYER_TYPES,
  LayerSchema,
  SlideModelSchema,
} from "../src/contract/index.ts";
import { parseSlide } from "../src/document/index.ts";
import { isRuleId, LINT_RULES, RULE_IDS } from "../src/lint/index.ts";
import { KIT_VERSION } from "../src/version.ts";
import { SLIDE_NAMES, slide } from "./helpers.ts";

const md = readFileSync(new URL("../contract/DESIGN_CONTRACT.v1.md", import.meta.url), "utf8");

describe("design contract v1 text", () => {
  it("the exported string is the shipped Markdown (run `pnpm sync:contract` after editing it)", () => {
    expect(DESIGN_CONTRACT_MD).toBe(md);
  });

  it("is v1", () => {
    expect(CONTRACT_VERSION).toBe("v1");
    expect(md).toMatch(/^# Design contract v1/);
    expect(md).toContain('<meta name="studio:contract" content="v1">');
  });

  it("only cites lint rules that exist", () => {
    const cited = new Set<string>();
    for (const m of md.matchAll(/\[lint: ([^\]]+)\]/g)) {
      for (const part of (m[1] as string).split(",")) {
        const id = part.trim().split(/\s/)[0] as string;
        if (id !== "rule-id") cited.add(id);
      }
    }
    expect(cited.size).toBeGreaterThan(40);
    for (const id of cited) expect(isRuleId(id), id).toBe(true);
  });

  it("names every layer type and role", () => {
    for (const t of LAYER_TYPES) expect(md).toContain(`\`${t}\``);
    for (const r of LAYER_ROLES) expect(md).toContain(`\`${r}\``);
  });

  it("package version and KIT_VERSION agree", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.version).toBe(KIT_VERSION);
  });
});

describe("rule registry", () => {
  it("has stable kebab-case ids with a stage and severity", () => {
    expect(RULE_IDS.length).toBeGreaterThanOrEqual(80);
    for (const id of RULE_IDS) {
      expect(id).toMatch(/^[a-z][a-z-]*$/);
      expect(["error", "warning", "info"]).toContain(LINT_RULES[id].severity);
      expect(["static", "layout", "pixel", "render", "carousel"]).toContain(LINT_RULES[id].stage);
    }
  });

  it("keeps every rule id the spike used", () => {
    const spike = [
      "lang",
      "artboard-count",
      "artboard-size",
      "artboard-overflow",
      "document-size",
      "forbidden-element",
      "forbidden-link",
      "brand-css-missing",
      "event-handler",
      "javascript-url",
      "css-url",
      "css-position",
      "css-viewport-unit",
      "css-animation",
      "css-import",
      "css-font-face",
      "colour-literal",
      "layer-id-format",
      "layer-id-duplicate",
      "layer-type",
      "layer-outside-artboard",
      "layer-nesting",
      "image-not-img",
      "shape-has-text",
      "group-empty",
      "text-nested-layer",
      "text-block-children",
      "text-empty",
      "text-layer-inline",
      "slot-ratio",
      "slot-ratio-mismatch",
      "slot-state",
      "slot-label",
      "slot-empty-has-img",
      "slot-filled-img",
      "slot-empty",
      "slot-has-text",
      "slot-too-small",
      "layer-count",
      "img-not-layer",
      "image-src",
      "image-broken",
      "image-upscaled",
      "image-distorted",
      "svg-outside-shape",
      "svg-content",
      "text-outside-text-layer",
      "undeclared-visual",
      "font-load",
      "text-occluded",
      "min-font-size",
      "small-font-size",
      "font-family",
      "text-clipped",
      "text-overflow-box",
      "text-truncated",
      "text-line-clamp",
      "text-outside-artboard",
      "safe-area",
      "widow",
      "unverified-number",
      "percentage",
      "text-overlap",
      "text-logo-overlap",
      "network-request",
      "contrast",
      "contrast-unknown",
      "contrast-busy-background",
    ];
    for (const id of spike) expect(isRuleId(id), id).toBe(true);
  });
});

describe("layer model schemas", () => {
  it.each(SLIDE_NAMES)("%s: the parsed model validates", (name) => {
    const { model } = parseSlide(slide(name));
    expect(() => SlideModelSchema.parse(model)).not.toThrow();
    for (const l of model.layers) expect(LayerSchema.safeParse(l).success).toBe(true);
  });
});
