import { describe, expect, it } from "vitest";
import { createSlideHtml } from "../src/document/index.ts";
import {
  extractNumbers,
  findUnverifiedNumbers,
  LINT_RULES,
  type LintConfig,
  LintReportSchema,
  lintForPrompt,
  lintSlideStatic,
  RULE_IDS,
  type RuleId,
} from "../src/lint/index.ts";
import { doc, FINAL_SLIDES, slide, ventaFacts } from "./helpers.ts";

const facts = ventaFacts();
const config: LintConfig = {
  width: 1080,
  height: 1350,
  allowedNumbers: facts.allowedNumbers,
  brandFonts: ["Archivo", "Montserrat"],
};
const T = (id: string, text: string, extra = "") =>
  `<p data-layer="${id}" data-type="text"${extra}>${text}</p>`;
const raw = (head: string, body: string, htmlAttrs = ' lang="tr"') =>
  `<!doctype html><html${htmlAttrs}><head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css">${head}</head><body><main data-artboard style="width:1080px;height:1350px">${body}</main></body></html>`;

/** One failing document per static rule. */
const FAILING: Partial<Record<RuleId, string>> = {
  "contract-version": raw("", T("t", "x")).replace(
    '<meta name="studio:contract" content="v1">',
    "",
  ),
  lang: raw("", T("t", "x"), ' lang="en"'),
  "artboard-count": raw(
    "",
    `${T("t", "x")}</main><main data-artboard style="width:1080px;height:1350px">`,
  ),
  "artboard-inline-size": raw("", T("t", "x")).replace(' style="width:1080px;height:1350px"', ""),
  "artboard-format-mismatch": raw("", T("t", "x")).replace(
    'content="1080x1350"',
    'content="1080x1080"',
  ),
  "forbidden-element": doc(`${T("t", "x")}<canvas></canvas>`),
  "forbidden-link": raw('<link rel="stylesheet" href="https://fonts.example/x.css">', T("t", "x")),
  "brand-css-missing": raw("", T("t", "x")).replace(
    '<link rel="stylesheet" href="/brand/brand.css">',
    "",
  ),
  "event-handler": doc(T("t", "x", ' onmouseover="x()"')),
  "javascript-url": doc(
    `${T("t", "x")}<div data-layer="s" data-type="shape" data-href="java\tscript:alert(1)"></div>`,
  ),
  "unsafe-markup": doc(`<a href="/x">${T("t", "x")}</a>`),
  "css-url": doc(T("t", "x"), ".x { background-image: url(/brand/assets/x.png) }"),
  "css-import": doc(T("t", "x"), "@import url(/brand/other.css);"),
  "css-font-face": doc(T("t", "x"), "@font-face { font-family: X; src: local(Arial) }"),
  "css-position": doc(T("t", "x", ' style="position: fixed"')),
  "css-viewport-unit": doc(T("t", "x", ' style="width: 50vw"')),
  "css-animation": doc(T("t", "x"), "p { transition: opacity 1s }"),
  "colour-literal": doc(T("t", "x", ' style="color: #7fd17f"')),
  "layer-id-format": doc(T("Headline", "x")),
  "layer-id-duplicate": doc(T("t", "x") + T("t", "y")),
  "layer-type": doc('<p data-layer="t" data-type="title">x</p>'),
  "layer-role": doc(T("t", "x", ' data-role="hero"')),
  "layer-outside-artboard": doc(T("t", "x")).replace("</body>", `${T("out", "y")}</body>`),
  "layer-nesting": doc(`<div data-layer="s" data-type="shape">${T("t", "x")}</div>`),
  "layer-count": doc(Array.from({ length: 46 }, (_, i) => T(`t${i}`, "x")).join("")),
  "image-not-img": doc('<div data-layer="i" data-type="image"></div>'),
  "img-not-layer": doc('<img src="/media/a.jpg" alt="">'),
  "image-src": doc('<img data-layer="i" data-type="image" src="https://cdn.example/a.jpg" alt="">'),
  "logo-src": doc('<img data-layer="l" data-type="logo" src="/media/logo.png" alt="">'),
  "svg-outside-shape": doc(
    '<div data-layer="g" data-type="group"><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' +
      T("t", "x") +
      "</div>",
  ),
  "svg-content": doc(
    '<svg data-layer="s" data-type="shape" viewBox="0 0 10 10"><text>x</text></svg>',
  ),
  "shape-has-text": doc('<div data-layer="s" data-type="shape">x</div>'),
  "group-empty": doc('<div data-layer="g" data-type="group"></div>'),
  "text-nested-layer": doc(
    '<div data-layer="t" data-type="text">x<span data-layer="u" data-type="text">y</span></div>',
  ),
  "text-block-children": doc('<div data-layer="t" data-type="text"><div>x</div></div>'),
  "text-empty": doc(T("t", "  ")),
  "slot-ratio": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="wide" data-slot-state="empty" data-slot-label="x"></figure>',
  ),
  "slot-state": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-label="x"></figure>',
  ),
  "slot-label": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty"></figure>',
  ),
  "slot-empty-has-img": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="x"><img data-slot-image src="/media/a.jpg" alt=""></figure>',
  ),
  "slot-filled-img": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="filled" data-slot-label="x"></figure>',
  ),
  "slot-has-text": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="x">Foto</figure>',
  ),
  "slot-empty": doc(
    '<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="x"></figure>',
  ),
  "unverified-number": doc(T("t", "Verimi yüzde 30 artırır")),
  percentage: doc(T("t", "%5 indirim")),
};

const staticRules = RULE_IDS.filter(
  (id) => LINT_RULES[id].stage === "static" && id !== "numbers-unchecked",
);

describe("static rules", () => {
  it("every static rule has a failing fixture", () => {
    expect(staticRules.filter((id) => !(id in FAILING))).toEqual([]);
  });

  it.each(staticRules)("%s fires on its failing fixture", (rule) => {
    const html = FAILING[rule] as string;
    const r = lintSlideStatic(html, config);
    expect(
      r.issues.map((i) => i.rule),
      JSON.stringify(r.issues, null, 1),
    ).toContain(rule);
    const i = r.issues.find((x) => x.rule === rule);
    expect(i?.severity).toBe(LINT_RULES[rule].severity);
  });

  it.each(FINAL_SLIDES)(
    "%s passes every static rule (only the v0 notice and empty slots remain)",
    (name) => {
      const r = lintSlideStatic(slide(name), config);
      expect(r.issues.filter((i) => !["contract-version", "slot-empty"].includes(i.rule))).toEqual(
        [],
      );
      expect(r.ok).toBe(true);
    },
  );

  it("a clean v1 document has no static issue at all", () => {
    const html = createSlideHtml({
      width: 1080,
      height: 1350,
      body: T("t", "Kullanmadan önce etiketi okuyunuz."),
    });
    expect(lintSlideStatic(html, config).issues).toEqual([]);
  });

  it("numbers-unchecked when no facts are given", () => {
    const r = lintSlideStatic(doc(T("t", "3 yıl")), { width: 1080, height: 1350 });
    expect(r.issues.map((i) => i.rule)).toEqual(["numbers-unchecked"]);
    expect(lintSlideStatic(doc(T("t", "yıl")), { width: 1080, height: 1350 }).issues).toEqual([]);
  });

  it("hidden layers are not checked for numbers", () => {
    const r = lintSlideStatic(doc(T("t", "Yüzde 30", " data-hidden")), config);
    expect(r.issues).toEqual([]);
  });

  it("reproduces the spike's verdict on its broken fixture (static part)", () => {
    const rules = new Set(lintSlideStatic(slide("spike-bad"), config).issues.map((i) => i.rule));
    for (const r of [
      "lang",
      "forbidden-element",
      "forbidden-link",
      "event-handler",
      "css-font-face",
      "css-url",
      "layer-id-format",
      "layer-type",
      "layer-id-duplicate",
      "image-src",
      "unverified-number",
      "colour-literal",
      "percentage",
    ])
      expect(rules, r).toContain(r);
  });
});

describe("report", () => {
  it("is versioned, validated, deterministic, and severities can be overridden", () => {
    const html = FAILING["colour-literal"] as string;
    const r = lintSlideStatic(html, config);
    expect(LintReportSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      schema: "studio.lint/1",
      contract: "v1",
      stages: { static: true, layout: false, pixel: false, render: false },
    });
    expect(lintSlideStatic(html, config)).toEqual(r);
    const strict = lintSlideStatic(html, { ...config, rules: { "colour-literal": "error" } });
    expect(strict.ok).toBe(false);
    expect(lintSlideStatic(html, { ...config, rules: { "colour-literal": "off" } }).issues).toEqual(
      [],
    );
  });

  it("sorts errors first and compacts for prompts", () => {
    const r = lintSlideStatic(slide("spike-bad"), config);
    const sev = r.issues.map((i) => i.severity);
    expect(sev).toEqual(
      [...sev].sort(
        (a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b),
      ),
    );
    const p = lintForPrompt(r);
    expect(p.issues[0]).toEqual({
      rule: r.issues[0]?.rule,
      severity: "error",
      layer: r.issues[0]?.layer,
      message: r.issues[0]?.message,
    });
  });
});

describe("numbers guard", () => {
  it("takes a unit only when attached and reads Turkish percentages", () => {
    expect(extractNumbers("Dekara 150 g/da uygulayın, %10 bor içerir.").map((n) => n.text)).toEqual(
      ["150", "%10"],
    );
    expect(extractNumbers("No:3b Kepez").map((n) => [n.core, n.suffix])).toEqual([["3", "b"]]);
    expect(extractNumbers("5°C – 45°C").map((n) => n.text)).toEqual(["5", "45"]);
    expect(extractNumbers("1,5 kg ve 2.5L").map((n) => n.text)).toEqual(["1,5", "2.5L"]);
  });

  it("accepts the brand's facts (zero-padded, attached units, separators)", () => {
    const allowed = facts.allowedNumbers;
    expect(
      findUnverifiedNumbers("Raf ömrü 3 yıl, 5°C – 45°C, No:3b, +90 507 036 49 39, 1/3", allowed),
    ).toEqual([]);
    expect(findUnverifiedNumbers("01 / 03", allowed)).toEqual([]);
    expect(findUnverifiedNumbers("2026'da %30 daha fazla", allowed).map((n) => n.text)).toEqual([
      "2026",
      "%30",
    ]);
    expect(findUnverifiedNumbers("1.5", ["1,5"])).toEqual([]);
  });
});
