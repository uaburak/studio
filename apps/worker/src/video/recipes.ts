/**
 * Reels compositions (1080×1920, driven frame by frame through `window.__seek(seconds)`):
 * 1. `motion_graphics`: kinetic brand typography scenes, optional hero image, closing sign-off;
 * 2. `footage_edit`: the user's clip under a hook badge, timed text overlays and word captions
 *    (rendered as transparent PNG frames and composited by ffmpeg);
 * 3. `narration`: voice-over with word-synchronised captions over brand visuals.
 *
 * Everything is built from a `ReelSpec` (packages/contract/src/reel.ts) plus the brand
 * profile (colours, fonts, logo from `/brand/brand.css`), so edits re-render without AI.
 */
import {
  type ContentVersion,
  encodeReelSpec,
  REEL_RECIPES,
  type ReelOverlay,
  type ReelRecipe,
  type ReelScene,
  type ReelSpec,
  type ReelWord,
  readReelVersionInfo,
} from "@studio/contract";
import { resolveUsage } from "@studio/design-kit/brand";
import { z } from "zod";
import type { BrandContext } from "../generate/brand.ts";

export { REEL_RECIPES, type ReelRecipe };

/** Safe area: Instagram covers ~220 px at the top, ~420 px at the bottom, ~140 px on the right. */
export const SAFE = { top: 240, right: 140, bottom: 440, left: 72 } as const;

// --- AI plan ----------------------------------------------------------------------------

export const ReelPlanSchema = z.object({
  hook: z.string().min(1).max(140),
  scenes: z
    .array(
      z.object({
        eyebrow: z.string().max(80).default(""),
        headline: z.string().min(1).max(160),
        subhead: z.string().max(240).default(""),
        durationSec: z.number().min(0.8).max(20).default(2.5),
      }),
    )
    .max(8)
    .default([]),
  narrationScript: z.string().max(2000).default(""),
  overlays: z
    .array(
      z.object({
        startMs: z.number().nonnegative(),
        endMs: z.number().positive(),
        caption: z.string().min(1).max(180),
      }),
    )
    .max(40)
    .default([]),
  cta: z.string().max(100).default(""),
  caption: z.string().max(4000).default(""),
  durationSec: z.number().min(1).max(900).default(8),
});
export type ReelPlan = z.infer<typeof ReelPlanSchema>;

export const REEL_PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["hook", "scenes", "narrationScript", "overlays", "cta", "caption", "durationSec"],
  properties: {
    hook: {
      type: "string",
      description: "İlk 2 saniyede izleyiciyi durduran Türkçe kanca (en fazla 8 kelime).",
    },
    scenes: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["eyebrow", "headline", "subhead", "durationSec"],
        properties: {
          eyebrow: { type: "string", description: "Kısa üst etiket (boş olabilir)." },
          headline: { type: "string", description: "Sahnenin ana cümlesi (en fazla 7 kelime)." },
          subhead: { type: "string", description: "İsteğe bağlı açıklama (en fazla 14 kelime)." },
          durationSec: { type: "number", description: "Sahne süresi (1.5-4 sn)." },
        },
      },
    },
    narrationScript: {
      type: "string",
      description:
        "Seslendirme metni (narration tarifinde; saniyede ~2,3 kelime). Diğer tariflerde boş.",
    },
    overlays: {
      type: "array",
      items: {
        type: "object",
        required: ["startMs", "endMs", "caption"],
        properties: {
          startMs: { type: "number" },
          endMs: { type: "number" },
          caption: { type: "string" },
        },
      },
    },
    cta: { type: "string", description: "Kapanış çağrısı veya marka imzası (en fazla 6 kelime)." },
    caption: {
      type: "string",
      description: "Gönderi açıklaması (VOICE kurallarına uygun, hashtagler sonda).",
    },
    durationSec: { type: "number", description: "Toplam süre (saniye)." },
  },
} as const;

export function inferReelRecipe(input: {
  explicitRecipe?: unknown;
  hasVideoClip?: boolean;
  brief: string;
  instructions?: string | null;
}): ReelRecipe {
  if (
    typeof input.explicitRecipe === "string" &&
    (REEL_RECIPES as readonly string[]).includes(input.explicitRecipe)
  ) {
    return input.explicitRecipe as ReelRecipe;
  }
  if (input.hasVideoClip) return "footage_edit";
  const text = `${input.brief}\n${input.instructions ?? ""}`.toLocaleLowerCase("tr");
  if (/seslendir|anlatım|anlatim|narration|voice ?over|dış ses|dis ses|sesli anlat/.test(text)) {
    return "narration";
  }
  if (/çekim|cekim|kurgu|klip|footage|video(mu|yu|dan)/.test(text)) return "footage_edit";
  return "motion_graphics";
}

const sec = (s: number) => Math.round(s * 1000);

/** AI plan → spec (assets and words are filled in by the engine). */
export function planToSpec(
  plan: ReelPlan,
  recipe: ReelRecipe,
  base: Partial<ReelSpec> = {},
): ReelSpec {
  const scenes: ReelScene[] = plan.scenes.slice(0, 8).map((s) => ({
    eyebrow: s.eyebrow.slice(0, 80),
    headline: s.headline.slice(0, 160),
    subhead: s.subhead.slice(0, 240),
    durationMs: Math.min(20_000, Math.max(800, sec(s.durationSec))),
  }));
  const overlays: ReelOverlay[] = plan.overlays
    .map((o) => ({
      text: o.caption.slice(0, 180),
      startMs: Math.round(o.startMs),
      endMs: Math.round(o.endMs),
    }))
    .filter((o) => o.endMs > o.startMs);
  return normalizeSpec({
    v: 1,
    recipe,
    hook: plan.hook.slice(0, 140),
    cta: plan.cta.slice(0, 100),
    scenes,
    overlays,
    narrationScript: recipe === "narration" ? plan.narrationScript.slice(0, 2000) : "",
    words: [],
    captions: true,
    durationMs: Math.max(3000, sec(plan.durationSec)),
    clipAssetId: null,
    clipStartMs: 0,
    audioAssetId: null,
    heroAssetId: null,
    voice: null,
    voiceAssetId: null,
    coverAtMs: null,
    ...base,
  });
}

/** Closing card length in `motion_graphics`. */
export const CTA_MS = 1800;

/** Keep the spec self-consistent: motion duration = scenes (+ closing card); clamp everything. */
export function normalizeSpec(spec: ReelSpec, maxMs = 90_000): ReelSpec {
  let durationMs = spec.durationMs;
  if (spec.recipe === "motion_graphics") {
    const scenes = spec.scenes.length
      ? spec.scenes
      : [{ eyebrow: "", headline: spec.hook || " ", subhead: "", durationMs: 3000 }];
    const total = scenes.reduce((a, s) => a + s.durationMs, 0) + (spec.cta ? CTA_MS : 0);
    durationMs = total;
    spec = { ...spec, scenes };
  }
  durationMs = Math.min(maxMs, Math.max(3000, Math.round(durationMs)));
  const clampTimes = <T extends { startMs: number; endMs: number }>(xs: readonly T[]) =>
    xs
      .filter((x) => x.startMs < durationMs)
      .map((x) => ({ ...x, endMs: Math.min(durationMs, Math.max(x.startMs + 100, x.endMs)) }));
  return {
    ...spec,
    durationMs,
    overlays: clampTimes(spec.overlays),
    words: clampTimes(spec.words),
    coverAtMs: spec.coverAtMs === null ? null : Math.min(durationMs - 100, spec.coverAtMs),
  };
}

export function buildFallbackPlan(input: {
  recipe: ReelRecipe;
  title: string;
  brief: string;
  brandName: string;
  transcriptText?: string;
  durationSec?: number;
}): ReelPlan {
  const clean = (input.brief.trim() || input.title.trim() || input.brandName).replace(/\s+/g, " ");
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const first = (sentences[0] ?? input.title).slice(0, 90);
  const second = (sentences[1] ?? `${input.brandName} ile tanışın.`).slice(0, 120);
  const words = (s: string, n: number) => s.split(/\s+/).slice(0, n).join(" ");
  const total = input.durationSec ?? 8;
  return {
    hook: words(input.title || first, 8),
    scenes: [
      {
        eyebrow: input.brandName,
        headline: words(input.title || first, 7),
        subhead: "",
        durationSec: 2.6,
      },
      { eyebrow: "", headline: words(first, 7), subhead: words(second, 14), durationSec: 3 },
    ],
    narrationScript: input.recipe === "narration" ? `${first} ${second}`.slice(0, 400) : "",
    overlays:
      input.recipe === "footage_edit"
        ? [
            { startMs: 2400, endMs: Math.min(total * 1000, 5600), caption: words(first, 9) },
            { startMs: 5600, endMs: total * 1000, caption: words(second, 9) },
          ]
        : [],
    cta: input.brandName,
    caption: `${first}\n\n#${input.brandName.toLocaleLowerCase("tr").replace(/[^a-z0-9çğıöşü]/g, "")}`,
    durationSec: total,
  };
}

// --- HTML -----------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, " ");
}

interface Palette {
  bg: string;
  ink: string;
  accent: string;
  muted: string;
  surface: string;
  display: string;
  text: string;
  logo: string | null;
}

function palette(brand: BrandContext): Palette {
  const u = resolveUsage(brand.tokens);
  return {
    bg: `var(--color-${u.background})`,
    ink: `var(--color-${u.text})`,
    accent: `var(--color-${u.accent})`,
    muted: `var(--color-${u.muted})`,
    surface: `var(--color-${u.slotFill})`,
    display: `var(--font-${u.displayFont}), sans-serif`,
    text: `var(--font-${u.textFont}), sans-serif`,
    logo: brand.logos.find((l) => l.on !== "dark")?.path ?? brand.logos[0]?.path ?? null,
  };
}

/** Word chunks of burned-in captions: up to 4 words, broken at sentence ends and pauses. */
export function captionChunks(
  words: readonly ReelWord[],
): { startMs: number; endMs: number; words: ReelWord[] }[] {
  const out: { startMs: number; endMs: number; words: ReelWord[] }[] = [];
  let cur: ReelWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startMs: cur[0]?.startMs ?? 0, endMs: cur.at(-1)?.endMs ?? 0, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && w.startMs - prev.endMs > 500) flush();
    cur.push(w);
    if (cur.length >= 4 || /[.!?…,;:]$/.test(w.word)) flush();
  }
  flush();
  // Hold each chunk until the next one starts (no flicker between words).
  for (let i = 0; i < out.length - 1; i++) {
    const cur2 = out[i];
    const next = out[i + 1];
    if (cur2 && next && next.startMs - cur2.endMs < 700) cur2.endMs = next.startMs;
  }
  return out;
}

function head(brand: BrandContext, p: Palette, extraCss: string, transparent = false): string {
  return `<!doctype html>
<html lang="${esc(brand.brand.defaultLanguage.split("-")[0] ?? "tr")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, height=1920">
<link rel="stylesheet" href="/brand/brand.css">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1080px; height: 1920px; overflow: hidden; background: ${transparent ? "transparent" : p.bg}; color: ${p.ink}; font-family: ${p.text}; -webkit-font-smoothing: antialiased; }
#root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
.fit { overflow-wrap: break-word; hyphens: manual; }
#captions { position: absolute; left: ${SAFE.left}px; right: ${SAFE.right}px; bottom: ${SAFE.bottom + 60}px; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px 14px; z-index: 50; }
#captions .w { font-family: ${p.display}; font-size: 60px; font-weight: 800; line-height: 1.12; color: #FFFFFF; padding: 6px 18px 10px; border-radius: 20px; background: rgba(12,12,12,0.78); }
#captions .w.on { background: ${p.accent}; }
#captions.inv .w { background: rgba(255,255,255,0.18); }
#captions.inv .w.on { background: #FFFFFF; color: #111111; }
${extraCss}
</style>
</head>`;
}

/** Shared runtime: easing, text fitting, captions. */
function runtime(chunks: ReturnType<typeof captionChunks>): string {
  return `
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (x) => { const t = clamp(x, 0, 1); return 1 - Math.pow(1 - t, 3); };
const easeIO = (x) => { const t = clamp(x, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
function fit(el, max, min) {
  if (!el) return;
  let size = max; el.style.fontSize = size + "px";
  const box = el.parentElement;
  while (size > min && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > (el.dataset.maxh ? Number(el.dataset.maxh) : 99999))) {
    size -= 4; el.style.fontSize = size + "px";
  }
}
const chunks = ${scriptJson(chunks)};
const capEl = document.getElementById("captions");
let lastChunk = -2;
function captions(ms) {
  if (!capEl) return;
  let idx = -1;
  for (let i = 0; i < chunks.length; i++) { if (ms >= chunks[i].startMs && ms <= chunks[i].endMs + 120) { idx = i; break; } }
  if (idx !== lastChunk) {
    capEl.innerHTML = "";
    if (idx >= 0) for (const w of chunks[idx].words) { const s = document.createElement("span"); s.className = "w"; s.textContent = w.word; capEl.appendChild(s); }
    lastChunk = idx;
  }
  if (idx < 0) return;
  const spans = capEl.children;
  let active = -1;
  chunks[idx].words.forEach((w, i) => { if (ms >= w.startMs) active = i; });
  for (let i = 0; i < spans.length; i++) spans[i].classList.toggle("on", i === active);
}`;
}

export interface BuiltComposition {
  html: string;
  durationMs: number;
  /** Frames have alpha and go over footage. */
  transparent: boolean;
}

export function buildMotionGraphicsHtml(input: {
  brand: BrandContext;
  spec: ReelSpec;
  heroImagePath?: string | null;
}): BuiltComposition {
  const { brand, spec } = input;
  const p = palette(brand);
  const scenes = spec.scenes;
  let cursor = 0;
  const timeline = scenes.map((s) => {
    const start = cursor;
    cursor += s.durationMs;
    return { ...s, start, end: cursor };
  });
  const ctaStart = cursor;
  const durationMs = spec.durationMs;
  const last = timeline.at(-1);
  if (last && !spec.cta) last.end = Math.max(last.end, durationMs);
  const heroIdx = input.heroImagePath ? Math.min(1, timeline.length - 1) : -1;
  const sections = timeline
    .map((s, idx) => {
      const words = s.headline
        .trim()
        .split(/\s+/)
        .map(
          (w, wi, arr) =>
            `<span class="word${wi === arr.length - 1 && arr.length > 2 ? " hi" : ""}">${esc(w)}</span>`,
        )
        .join(" ");
      return `<section class="scene" data-start="${s.start}" data-end="${s.end}">
  <div class="safe">
    ${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ""}
    <div class="rule"></div>
    ${idx === heroIdx ? `<div class="hero"><img src="${esc(input.heroImagePath ?? "")}" alt=""></div>` : ""}
    <h1 class="headline fit" data-maxh="${idx === heroIdx ? 420 : 760}">${words}</h1>
    ${s.subhead ? `<p class="subhead">${esc(s.subhead)}</p>` : ""}
  </div>
</section>`;
    })
    .join("\n");
  const closing = spec.cta
    ? `<section class="scene closing" data-start="${ctaStart}" data-end="${durationMs}">
  <div class="safe center">
    ${p.logo ? `<img class="logo" src="${esc(p.logo)}" alt="">` : `<p class="brand">${esc(brand.brand.name)}</p>`}
    <h2 class="cta fit" data-maxh="420">${esc(spec.cta)}</h2>
  </div>
</section>`
    : "";
  const css = `
.scene { position: absolute; inset: 0; background: ${p.bg}; display: none; }
.scene.closing { background: ${p.accent}; color: #FFFFFF; }
.safe { position: absolute; top: ${SAFE.top + 40}px; right: ${SAFE.right}px; bottom: ${SAFE.bottom}px; left: ${SAFE.left}px; display: flex; flex-direction: column; justify-content: center; gap: 34px; }
.safe.center { align-items: flex-start; }
.eyebrow { font-family: ${p.text}; font-size: 30px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${p.accent}; }
.rule { width: 84px; height: 10px; background: ${p.accent}; border-radius: 5px; transform-origin: left center; }
.hero { width: 868px; height: 560px; border-radius: 40px; overflow: hidden; background: ${p.surface}; }
.hero img { width: 100%; height: 100%; object-fit: cover; display: block; }
.headline { font-family: ${p.display}; font-size: 112px; font-weight: 800; line-height: 1.02; letter-spacing: -0.02em; width: 868px; }
.word { display: inline-block; }
.word.hi { color: ${p.accent}; }
.subhead { font-family: ${p.text}; font-size: 42px; font-weight: 500; line-height: 1.3; color: ${p.muted}; max-width: 820px; }
.logo { max-height: 110px; max-width: 520px; object-fit: contain; filter: brightness(0) invert(1); }
.brand { font-family: ${p.text}; font-size: 34px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.cta { font-family: ${p.display}; font-size: 104px; font-weight: 800; line-height: 1.02; letter-spacing: -0.02em; width: 868px; }
#bar { position: absolute; left: ${SAFE.left}px; right: ${SAFE.right}px; top: ${SAFE.top - 40}px; height: 6px; border-radius: 3px; background: rgba(127,127,127,0.22); overflow: hidden; z-index: 40; }
#fill { height: 100%; width: 0; background: ${p.accent}; }
.closing ~ #bar #fill { background: #FFFFFF; }`;
  const html = `${head(brand, p, css)}
<body>
<div id="root">
${sections}
${closing}
<div id="bar"><div id="fill"></div></div>
<div id="captions"></div>
</div>
<script>
(function () {
${runtime(spec.captions ? captionChunks(spec.words) : [])}
const total = ${durationMs};
const scenes = Array.from(document.querySelectorAll(".scene")).map((el, i) => ({
  el, i, start: Number(el.dataset.start), end: Number(el.dataset.end),
  words: Array.from(el.querySelectorAll(".word")), rule: el.querySelector(".rule"),
  hero: el.querySelector(".hero"), sub: el.querySelector(".subhead"), eyebrow: el.querySelector(".eyebrow"),
  cta: el.querySelector(".cta"), logo: el.querySelector(".logo, .brand"), closing: el.classList.contains("closing"),
}));
const refit = () => document.querySelectorAll(".fit").forEach((el) => fit(el, el.classList.contains("cta") ? 104 : 112, 56));
refit();
window.__refit = () => { refit(); };
const fill = document.getElementById("fill");
window.__seek = function (seconds) {
  const ms = clamp(Number(seconds) * 1000 || 0, 0, total);
  fill.style.width = (ms / total * 100).toFixed(2) + "%";
  fill.style.background = ms >= ${ctaStart} && ${spec.cta ? "true" : "false"} ? "#FFFFFF" : "";
  for (const s of scenes) {
    const enterMs = s.i === 0 ? 0 : 380;
    const visible = ms >= s.start - enterMs && ms < s.end + 1;
    s.el.style.display = visible ? "block" : "none";
    if (!visible) continue;
    s.el.style.zIndex = String(s.i + 1);
    const enter = s.i === 0 ? 1 : easeIO((ms - (s.start - enterMs)) / enterMs);
    s.el.style.transform = "translateY(" + ((1 - enter) * 100).toFixed(2) + "%)";
    const local = ms - s.start + (s.i === 0 ? 0 : 320);
    if (s.rule) s.rule.style.transform = "scaleX(" + ease(local / 450).toFixed(3) + ")";
    if (s.eyebrow) s.eyebrow.style.opacity = ease(local / 400).toFixed(3);
    s.words.forEach((w, wi) => {
      const k = ease((local - 60 - wi * 80) / 420);
      w.style.opacity = k.toFixed(3);
      w.style.transform = "translateY(" + ((1 - k) * 56).toFixed(1) + "px)";
    });
    if (s.hero) { const k = ease((local - 120) / 600); s.hero.style.opacity = k.toFixed(3); s.hero.style.transform = "scale(" + (0.92 + 0.08 * k).toFixed(4) + ")"; }
    if (s.sub) { const k = ease((local - 380) / 500); s.sub.style.opacity = k.toFixed(3); s.sub.style.transform = "translateY(" + ((1 - k) * 30).toFixed(1) + "px)"; }
    if (s.cta) { const k = ease((local - 100) / 500); s.cta.style.opacity = k.toFixed(3); s.cta.style.transform = "translateY(" + ((1 - k) * 40).toFixed(1) + "px)"; }
    if (s.logo) s.logo.style.opacity = ease(local / 400).toFixed(3);
  }
  captions(ms);
};
window.__seek(0);
})();
</script>
</body>
</html>`;
  return { html, durationMs, transparent: false };
}

export function buildFootageEditHtml(input: {
  brand: BrandContext;
  spec: ReelSpec;
  /** True: frames are transparent and go over the clip. False: a still image backdrop. */
  overClip: boolean;
  stillImagePath?: string | null;
}): BuiltComposition {
  const { brand, spec } = input;
  const p = palette(brand);
  const wordCaptions = spec.captions && spec.words.length > 0;
  const overlays = spec.overlays;
  const css = `
.still { position: absolute; inset: 0; width: 1080px; height: 1920px; object-fit: cover; transform-origin: center; }
.scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.55) 100%); }
#hook { position: absolute; top: ${SAFE.top + 40}px; left: ${SAFE.left}px; right: ${SAFE.right}px; }
#hook span { display: inline; font-family: ${p.display}; font-size: 72px; font-weight: 800; line-height: 1.22; color: #FFFFFF; background: ${p.accent}; padding: 4px 22px 10px; border-radius: 22px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
#overlay { position: absolute; left: ${SAFE.left}px; right: ${SAFE.right}px; ${wordCaptions ? `top: ${SAFE.top + 40}px` : `bottom: ${SAFE.bottom + 60}px`}; display: none; }
#overlay span { display: inline; font-family: ${p.display}; font-size: 58px; font-weight: 800; line-height: 1.26; color: #FFFFFF; background: rgba(12,12,12,0.78); padding: 4px 20px 10px; border-radius: 20px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
#tag { position: absolute; left: ${SAFE.left}px; bottom: ${SAFE.bottom - 20}px; display: flex; align-items: center; gap: 16px; }
#tag img { height: 54px; max-width: 280px; object-fit: contain; filter: brightness(0) invert(1); }
#tag p { font-family: ${p.text}; font-size: 28px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #FFFFFF; }`;
  const html = `${head(brand, p, css, input.overClip)}
<body>
<div id="root">
${!input.overClip && input.stillImagePath ? `<img class="still" id="still" src="${esc(input.stillImagePath)}" alt="">` : ""}
<div class="scrim"></div>
${spec.hook ? `<div id="hook"><span>${esc(spec.hook)}</span></div>` : ""}
<div id="overlay"><span></span></div>
<div id="captions"></div>
<div id="tag">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : `<p>${esc(brand.brand.name)}</p>`}</div>
</div>
<script>
(function () {
${runtime(wordCaptions ? captionChunks(spec.words) : [])}
const total = ${spec.durationMs};
const overlays = ${scriptJson(overlays)};
const hook = document.getElementById("hook");
const ov = document.getElementById("overlay");
const ovText = ov.querySelector("span");
const still = document.getElementById("still");
const hookEnd = overlays.length ? Math.min(2600, overlays[0].startMs || 2600) : 2600;
let lastOv = -2;
window.__seek = function (seconds) {
  const ms = clamp(Number(seconds) * 1000 || 0, 0, total);
  if (hook) {
    const on = ms < hookEnd;
    hook.style.display = on ? "block" : "none";
    if (on) { const k = ease(ms / 320) * (1 - ease((ms - hookEnd + 240) / 240)); hook.style.opacity = k.toFixed(3); hook.style.transform = "translateY(" + ((1 - ease(ms / 320)) * -30).toFixed(1) + "px)"; }
  }
  if (still) still.style.transform = "scale(" + (1 + 0.08 * ms / total).toFixed(4) + ")";
  let idx = -1;
  for (let i = 0; i < overlays.length; i++) if (ms >= overlays[i].startMs && ms < overlays[i].endMs) { idx = i; break; }
  if (idx !== lastOv) { ov.style.display = idx >= 0 ? "block" : "none"; if (idx >= 0) ovText.textContent = overlays[idx].text; lastOv = idx; }
  if (idx >= 0) { const k = ease((ms - overlays[idx].startMs) / 220); ov.style.opacity = k.toFixed(3); ov.style.transform = "translateY(" + ((1 - k) * 22).toFixed(1) + "px)"; }
  captions(ms);
};
window.__seek(0);
})();
</script>
</body>
</html>`;
  return { html, durationMs: spec.durationMs, transparent: input.overClip };
}

export function buildNarrationHtml(input: {
  brand: BrandContext;
  spec: ReelSpec;
  heroImagePath?: string | null;
}): BuiltComposition {
  const { brand, spec } = input;
  const p = palette(brand);
  const total = spec.durationMs;
  const headlines = spec.scenes.map((s) => s.headline).filter(Boolean);
  const ctaFrom = spec.cta ? Math.max(total - 1800, total * 0.75) : total + 1;
  const css = `
#top { position: absolute; top: ${SAFE.top + 20}px; left: ${SAFE.left}px; right: ${SAFE.right}px; display: flex; flex-direction: column; gap: 22px; }
.eyebrow { font-family: ${p.text}; font-size: 30px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${p.accent}; }
#hookline { font-family: ${p.display}; font-size: 84px; font-weight: 800; line-height: 1.04; letter-spacing: -0.02em; width: 868px; }
#visual { position: absolute; left: ${SAFE.left}px; right: ${SAFE.right}px; top: 640px; height: 520px; border-radius: 40px; overflow: hidden; background: ${p.surface}; display: flex; align-items: center; justify-content: center; }
#visual img { width: 100%; height: 100%; object-fit: cover; transform-origin: center; }
#scene { font-family: ${p.display}; font-size: 64px; font-weight: 800; line-height: 1.08; padding: 0 56px; text-align: left; width: 100%; color: ${p.ink}; }
#ctaCard { position: absolute; inset: 0; background: ${p.accent}; color: #FFFFFF; display: none; }
#ctaCard .in { position: absolute; top: ${SAFE.top + 40}px; right: ${SAFE.right}px; bottom: ${SAFE.bottom}px; left: ${SAFE.left}px; display: flex; flex-direction: column; justify-content: center; gap: 30px; }
#ctaCard img { max-height: 110px; max-width: 520px; object-fit: contain; filter: brightness(0) invert(1); align-self: flex-start; }
#ctaCard h2 { font-family: ${p.display}; font-size: 104px; font-weight: 800; line-height: 1.02; letter-spacing: -0.02em; width: 868px; }`;
  const html = `${head(brand, p, css)}
<body>
<div id="root">
<div id="top">
  <p class="eyebrow">${esc(brand.brand.name)}</p>
  <h1 id="hookline" class="fit" data-maxh="330">${esc(spec.hook)}</h1>
</div>
<div id="visual">${input.heroImagePath ? `<img id="hero" src="${esc(input.heroImagePath)}" alt="">` : `<p id="scene" class="fit" data-maxh="460"></p>`}</div>
${spec.cta ? `<div id="ctaCard"><div class="in">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ""}<h2 class="fit" data-maxh="420">${esc(spec.cta)}</h2></div></div>` : ""}
<div id="captions"></div>
</div>
<script>
(function () {
${runtime(spec.captions ? captionChunks(spec.words) : [])}
const total = ${total};
const heads = ${scriptJson(headlines.length ? headlines : [spec.hook])};
const sceneEl = document.getElementById("scene");
const hero = document.getElementById("hero");
const top = document.getElementById("top");
const card = document.getElementById("ctaCard");
const fitMax = new Map();
const refit = () => document.querySelectorAll(".fit").forEach((el) => { if (!fitMax.has(el)) fitMax.set(el, parseFloat(getComputedStyle(el).fontSize)); fit(el, fitMax.get(el), 48); });
refit();
let lastScene = -1;
window.__refit = () => { refit(); lastScene = -1; };
window.__seek = function (seconds) {
  const ms = clamp(Number(seconds) * 1000 || 0, 0, total);
  const k = ease(ms / 450);
  top.style.opacity = k.toFixed(3);
  top.style.transform = "translateY(" + ((1 - k) * 30).toFixed(1) + "px)";
  if (hero) hero.style.transform = "scale(" + (1.04 + 0.08 * ms / total).toFixed(4) + ")";
  if (sceneEl) {
    const idx = Math.min(heads.length - 1, Math.floor(ms / Math.max(1, ${Math.min(ctaFrom, total)}) * heads.length));
    if (idx !== lastScene) { sceneEl.textContent = heads[idx] || ""; fit(sceneEl, 64, 40); lastScene = idx; }
    const segLen = ${Math.min(ctaFrom, total)} / heads.length;
    const local = ms - idx * segLen;
    const s = ease(local / 380);
    sceneEl.style.opacity = s.toFixed(3);
    sceneEl.style.transform = "translateY(" + ((1 - s) * 26).toFixed(1) + "px)";
  }
  if (card) {
    const on = ms >= ${Math.round(ctaFrom)};
    card.style.display = on ? "block" : "none";
    if (on) { const c = easeIO((ms - ${Math.round(ctaFrom)}) / 420); card.style.transform = "translateY(" + ((1 - c) * 100).toFixed(2) + "%)"; }
    if (capEl) capEl.classList.toggle("inv", on);
  }
  captions(ms);
};
window.__seek(0);
})();
</script>
</body>
</html>`;
  return { html, durationMs: total, transparent: false };
}

// --- Version slide ------------------------------------------------------------------------

/**
 * The one slide stored in a reel version: the cover image full-bleed (what every static
 * preview shows) and the reel's metadata + spec on `<main data-artboard>`.
 */
export function buildReelVersionSlideHtml(input: {
  spec: ReelSpec;
  videoAssetId: string;
  coverAssetId: string;
  language?: string;
}): string {
  const s = input.spec;
  return `<!doctype html>
<html lang="${esc((input.language ?? "tr").split("-")[0] ?? "tr")}">
<head>
<meta charset="utf-8">
<meta name="studio:contract" content="v1">
<meta name="studio:format" content="1080x1920">
<meta name="studio:kind" content="reel">
<style>main[data-artboard] { position: relative; overflow: hidden; background: #000; } .reel-cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }</style>
</head>
<body>
<main data-artboard data-reel="1" data-video-asset-id="${esc(input.videoAssetId)}" data-cover-asset-id="${esc(input.coverAssetId)}" data-reel-recipe="${s.recipe}" data-duration-ms="${s.durationMs}" data-reel-spec-b64="${encodeReelSpec(s)}" style="width:1080px;height:1920px">
<img data-layer="cover" data-type="image" class="reel-cover" src="/media/${esc(input.coverAssetId)}.jpg" alt="${esc(s.hook)}">
</main>
</body>
</html>`;
}

export interface ExtractedReelAssets {
  videoAssetId: string | null;
  coverAssetId: string | null;
  recipe: ReelRecipe | null;
  durationMs: number | null;
  spec: ReelSpec | null;
  /** Legacy versions (before P6) stored the composition HTML instead of a spec. */
  compositionHtml: string | null;
}

export function extractReelVersionAssets(
  version: Pick<ContentVersion, "slides" | "note">,
): ExtractedReelAssets {
  const slide = version.slides[0];
  const html = slide?.html ?? "";
  const info = readReelVersionInfo(html);
  const b64 = /data-reel-composition-b64="([^"]+)"/.exec(html)?.[1];
  let compositionHtml: string | null = null;
  if (b64) {
    try {
      compositionHtml = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      compositionHtml = null;
    }
  }
  return {
    videoAssetId: info.videoAssetId,
    coverAssetId: info.coverAssetId ?? slide?.renderedAssetId ?? null,
    recipe: info.recipe,
    durationMs: info.durationMs,
    spec: info.spec,
    compositionHtml,
  };
}
