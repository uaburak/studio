/**
 * All 3 Reels recipes (`PLAN.md` §7):
 * 1. `motion_graphics`: animated 1080x1920 brand typography + hero card + closing sign-off (`window.__seek(t)`),
 * 2. `footage_edit`: cut plan + Turkish hook banner + synced caption overlays from clip transcript (`window.__seek(t)`),
 * 3. `narration`: spoken Turkish voiceover + word-synchronized pill/karaoke subtitles (`window.__seek(t)`).
 */
import type { ContentVersion } from "@studio/contract";
import { resolveUsage } from "@studio/design-kit/brand";
import { z } from "zod";
import type { BrandContext } from "../generate/brand.ts";
import type { TranscriptionResult } from "./transcribe.ts";
import type { WordTimestamp } from "./tts.ts";

export const REEL_RECIPES = ["motion_graphics", "footage_edit", "narration"] as const;
export type ReelRecipe = (typeof REEL_RECIPES)[number];

export const ReelSceneSchema = z.object({
  eyebrow: z.string().max(80).default(""),
  headline: z.string().min(1).max(160),
  subhead: z.string().max(240).default(""),
  durationSec: z.number().min(1.2).max(10).default(2.5),
});
export type ReelScene = z.infer<typeof ReelSceneSchema>;

export const ReelCutOverlaySchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
  caption: z.string().min(1).max(180),
  emphasisWord: z.string().max(60).optional(),
});
export type ReelCutOverlay = z.infer<typeof ReelCutOverlaySchema>;

export const ReelPlanSchema = z.object({
  recipe: z.enum(REEL_RECIPES).optional(),
  hook: z.string().min(1).max(140),
  scenes: z.array(ReelSceneSchema).min(1).max(6).default([]),
  narrationScript: z.string().max(1200).default(""),
  overlays: z.array(ReelCutOverlaySchema).max(20).default([]),
  cta: z.string().max(100).default(""),
  caption: z.string().max(4000).default(""),
  durationSec: z.number().min(3).max(30).default(6),
});
export type ReelPlan = z.infer<typeof ReelPlanSchema>;

export const REEL_PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["hook", "scenes", "narrationScript", "overlays", "cta", "caption", "durationSec"],
  properties: {
    hook: {
      type: "string",
      description: "İlk 2 saniyede izleyiciyi durduran Türkçe kanca başlık.",
    },
    scenes: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        required: ["eyebrow", "headline", "subhead", "durationSec"],
        properties: {
          eyebrow: { type: "string" },
          headline: { type: "string" },
          subhead: { type: "string" },
          durationSec: { type: "number" },
        },
      },
    },
    narrationScript: {
      type: "string",
      description:
        "Seslendirmeli anlatım (narration) tarifi için doğal Türkçe seslendirme metni (12-30 kelime).",
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
          emphasisWord: { type: "string" },
        },
      },
    },
    cta: { type: "string", description: "Kapanış çağrısı veya marka imzası." },
    caption: { type: "string", description: "Gönderi açıklaması (VOICE kurallarına uygun)." },
    durationSec: { type: "number", description: "Toplam süre (saniye, tipik 5-8)." },
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
  const combined = `${input.brief}\n${input.instructions ?? ""}`.toLocaleLowerCase("tr");
  if (/seslendir|anlatım|anlatim|narration|voiceover|konuşma|konusma|sesli/.test(combined)) {
    return "narration";
  }
  if (/çekim|cekim|kurgu|klip|footage/.test(combined)) {
    return "footage_edit";
  }
  return "motion_graphics";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandPaletteVars(brand: BrandContext): {
  bg: string;
  ink: string;
  accent: string;
  muted: string;
  surface: string;
  logoPath: string | null;
} {
  const u = resolveUsage(brand.tokens);
  return {
    bg: `var(--color-${u.background})`,
    ink: `var(--color-${u.text})`,
    accent: `var(--color-${u.accent})`,
    muted: `var(--color-${u.muted})`,
    surface: `var(--color-${u.slotFill})`,
    logoPath: brand.logos[0]?.path ?? null,
  };
}

export function buildFallbackReelPlan(input: {
  recipe: ReelRecipe;
  title: string;
  brief: string;
  brandName: string;
  transcript?: TranscriptionResult | null;
}): ReelPlan {
  const cleanBrief = input.brief.trim() || input.title.trim() || input.brandName;
  const firstSentence = cleanBrief.split(/[.!?]\s+/)[0]?.slice(0, 90) || input.title;
  const secondSentence =
    cleanBrief.split(/[.!?]\s+/)[1]?.slice(0, 120) || `${input.brandName} ile güçlü görünüm.`;
  const overlays: ReelCutOverlay[] =
    input.transcript && input.transcript.segments.length > 0
      ? input.transcript.segments.slice(0, 8).map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          caption: s.text.slice(0, 160),
        }))
      : [
          { startMs: 0, endMs: 2500, caption: firstSentence },
          { startMs: 2500, endMs: 5500, caption: secondSentence },
        ];
  const durationSec =
    input.transcript && input.transcript.segments.length > 0
      ? Math.min(15, Math.max(4, Math.ceil((overlays.at(-1)?.endMs ?? 6000) / 1000)))
      : 6;

  return {
    recipe: input.recipe,
    hook: input.title.slice(0, 100) || firstSentence,
    scenes: [
      {
        eyebrow: input.brandName,
        headline: input.title || firstSentence,
        subhead: "",
        durationSec: 2.2,
      },
      { eyebrow: "", headline: firstSentence, subhead: secondSentence, durationSec: 2.3 },
      { eyebrow: "", headline: input.brandName, subhead: "Detaylar açıklamada", durationSec: 1.5 },
    ],
    narrationScript: `${firstSentence}. ${secondSentence}`,
    overlays,
    cta: input.brandName,
    caption: `${firstSentence}\n\n#${input.brandName.toLocaleLowerCase("tr").replace(/[^a-z0-9çğıöşü]/g, "")}`,
    durationSec,
  };
}

/**
 * Recipe 1: `motion_graphics` — 1080x1920 brand kinetic typography + optional image reveal,
 * deterministically driven by `window.__seek(timeSeconds)` updating `--t` and scene states.
 */
export function buildMotionGraphicsHtml(input: {
  brand: BrandContext;
  plan: ReelPlan;
  heroImagePath?: string | null;
}): { html: string; durationMs: number; transparent: false } {
  const p = brandPaletteVars(input.brand);
  const scenes =
    input.plan.scenes.length > 0
      ? input.plan.scenes
      : [
          {
            eyebrow: input.brand.brand.name,
            headline: input.plan.hook,
            subhead: "",
            durationSec: 3,
          },
          {
            eyebrow: "",
            headline: input.plan.cta || input.brand.brand.name,
            subhead: "",
            durationSec: 3,
          },
        ];
  const totalSec = Math.max(
    3,
    scenes.reduce((sum, s) => sum + s.durationSec, 0),
  );
  const durationMs = Math.round(totalSec * 1000);

  let cursor = 0;
  const timelineMeta = scenes.map((s, idx) => {
    const start = cursor;
    const end = cursor + s.durationSec;
    cursor = end;
    return { ...s, idx, start, end };
  });

  const sceneSections = timelineMeta
    .map((s, idx) => {
      const words = s.headline
        .trim()
        .split(/\s+/)
        .map(
          (w, wi, arr) =>
            `<span class="word${wi >= arr.length - 1 && arr.length > 1 ? " accent" : ""}" data-wi="${wi}">${escapeHtml(w)}</span>`,
        )
        .join(" ");
      const showHero = Boolean(input.heroImagePath && idx === Math.min(1, timelineMeta.length - 1));
      const isClosing = idx === timelineMeta.length - 1 && timelineMeta.length > 1;
      return `<section class="scene${isClosing ? " closing" : ""}" id="scene-${idx}" data-start="${s.start.toFixed(3)}" data-end="${s.end.toFixed(3)}">
        <div class="safe">
          ${s.eyebrow ? `<p class="eyebrow">${escapeHtml(s.eyebrow)}</p><div class="rule"></div>` : '<div class="rule"></div>'}
          ${showHero ? `<div class="hero-card"><img src="${escapeHtml(input.heroImagePath ?? "")}" alt=""></div>` : ""}
          <h1 class="headline">${words}</h1>
          ${s.subhead ? `<p class="subhead">${escapeHtml(s.subhead)}</p>` : ""}
          <div class="footer">
            ${p.logoPath ? `<img class="brand-logo" src="${escapeHtml(p.logoPath)}" alt="${escapeHtml(input.brand.brand.name)}">` : `<span class="brand-name">${escapeHtml(input.brand.brand.name)}</span>`}
            <span class="progress-pill">${idx + 1} / ${timelineMeta.length}</span>
          </div>
        </div>
      </section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="${escapeHtml(input.brand.brand.defaultLanguage.split("-")[0] ?? "tr")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, height=1920">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    :root { --t: 0; --progress: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1080px; height: 1920px; overflow: hidden; background: ${p.bg}; color: ${p.ink}; font-family: var(--font-text, sans-serif); }
    #reel-root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: ${p.bg}; }
    .scene { position: absolute; inset: 0; background: ${p.bg}; will-change: transform, opacity; }
    .scene.closing { background: ${p.accent}; color: #FFFFFF; }
    .safe {
      position: absolute; top: 240px; right: 140px; bottom: 420px; left: 72px;
      display: flex; flex-direction: column; justify-content: center; gap: 36px;
    }
    .eyebrow {
      font-family: var(--font-text, sans-serif); font-size: 28px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: ${p.accent};
    }
    .scene.closing .eyebrow { color: #FFFFFF; opacity: 0.9; }
    .rule { width: 72px; height: 8px; background: ${p.accent}; border-radius: 4px; }
    .scene.closing .rule { background: #FFFFFF; }
    .hero-card {
      width: 720px; height: 540px; border-radius: 36px; overflow: hidden;
      background: ${p.surface}; box-shadow: 0 32px 72px rgba(0,0,0,0.14);
    }
    .hero-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .headline {
      font-family: var(--font-display, sans-serif); font-size: 96px; font-weight: 800;
      line-height: 1.04; letter-spacing: -0.02em;
    }
    .word { display: inline-block; margin-right: 0.22em; }
    .word.accent { color: ${p.accent}; }
    .scene.closing .word.accent { color: #FFFFFF; text-decoration: underline; }
    .subhead {
      font-family: var(--font-text, sans-serif); font-size: 40px; font-weight: 500;
      line-height: 1.32; color: ${p.muted}; max-width: 820px;
    }
    .scene.closing .subhead { color: rgba(255,255,255,0.92); }
    .footer {
      margin-top: auto; display: flex; align-items: center; justify-content: space-between;
      padding-top: 24px;
    }
    .brand-logo { height: 42px; width: auto; object-fit: contain; }
    .brand-name { font-size: 30px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .progress-pill {
      font-size: 26px; font-weight: 700; padding: 10px 22px; border-radius: 999px;
      background: ${p.surface}; color: ${p.ink};
    }
    #progress-bar {
      position: absolute; left: 72px; right: 140px; top: 200px; height: 6px;
      background: rgba(0,0,0,0.1); border-radius: 999px; overflow: hidden; z-index: 20;
    }
    #progress-fill { height: 100%; width: calc(var(--progress) * 100%); background: ${p.accent}; }
  </style>
</head>
<body>
  <div id="reel-root" data-duration="${totalSec.toFixed(3)}" data-fps="30">
    <div id="progress-bar"><div id="progress-fill"></div></div>
    ${sceneSections}
  </div>
  <script>
    (function () {
      const total = ${totalSec.toFixed(4)};
      const scenes = Array.from(document.querySelectorAll(".scene")).map((el, i) => ({
        el,
        idx: i,
        start: Number(el.getAttribute("data-start") || 0),
        end: Number(el.getAttribute("data-end") || total),
        words: Array.from(el.querySelectorAll(".word")),
        card: el.querySelector(".hero-card"),
        sub: el.querySelector(".subhead")
      }));
      function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
      function easeOutCubic(x) { const t = clamp(x, 0, 1); return 1 - Math.pow(1 - t, 3); }
      function easeInOutCubic(x) {
        const t = clamp(x, 0, 1);
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }
      window.__seek = function (timeSeconds) {
        const t = clamp(Number(timeSeconds) || 0, 0, total);
        document.documentElement.style.setProperty("--t", String(t));
        document.documentElement.style.setProperty("--progress", String(t / total));
        for (const s of scenes) {
          const local = t - s.start;
          const enter = s.idx === 0 ? 1 : easeInOutCubic((t - (s.start - 0.35)) / 0.35);
          const visible = t >= s.start - 0.35 && t <= s.end + 0.4;
          s.el.style.display = visible ? "block" : "none";
          s.el.style.zIndex = String(s.idx + 1);
          s.el.style.transform = "translateY(" + ((1 - enter) * 100).toFixed(2) + "%)";
          for (let wi = 0; wi < s.words.length; wi++) {
            const wp = easeOutCubic((local - 0.08 - wi * 0.09) / 0.42);
            const w = s.words[wi];
            w.style.opacity = wp.toFixed(3);
            w.style.transform = "translateY(" + ((1 - wp) * 48).toFixed(1) + "px)";
          }
          if (s.card) {
            const cp = easeOutCubic((local - 0.12) / 0.55);
            s.card.style.opacity = cp.toFixed(3);
            s.card.style.transform = "scale(" + (0.9 + 0.1 * cp).toFixed(3) + ")";
          }
          if (s.sub) {
            const sp = easeOutCubic((local - 0.3) / 0.45);
            s.sub.style.opacity = sp.toFixed(3);
            s.sub.style.transform = "translateY(" + ((1 - sp) * 28).toFixed(1) + "px)";
          }
        }
      };
      window.__seek(0);
    })();
  </script>
</body>
</html>`;

  return { html, durationMs, transparent: false };
}

/**
 * Recipe 2: `footage_edit` — dynamic Turkish hook banner + cut-synced subtitle overlays.
 * When `hasBackgroundVideo` is true, renders with a transparent canvas (`transparent: true`)
 * so FFmpeg composites it cleanly over the source clip; otherwise renders an editorial backdrop.
 */
export function buildFootageEditHtml(input: {
  brand: BrandContext;
  plan: ReelPlan;
  hasBackgroundVideo: boolean;
  stillImagePath?: string | null;
}): { html: string; durationMs: number; transparent: boolean } {
  const p = brandPaletteVars(input.brand);
  const durationMs = Math.round(Math.max(3, input.plan.durationSec) * 1000);
  const overlays: ReelCutOverlay[] =
    input.plan.overlays.length > 0
      ? input.plan.overlays
      : [{ startMs: 0, endMs: durationMs, caption: input.plan.hook }];

  const html = `<!doctype html>
<html lang="${escapeHtml(input.brand.brand.defaultLanguage.split("-")[0] ?? "tr")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, height=1920">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    :root { --t: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 1080px; height: 1920px; overflow: hidden;
      background: ${input.hasBackgroundVideo ? "transparent" : p.ink};
      font-family: var(--font-text, sans-serif);
    }
    #stage { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
    .still-bg {
      position: absolute; inset: 0; width: 1080px; height: 1920px; object-fit: cover;
      opacity: 0.65; transform-origin: center center;
    }
    .gradient-scrim {
      position: absolute; inset: 0;
      background: linear-gradient(180deg, rgba(0,0,0,0.48) 0%, rgba(0,0,0,0.08) 40%, rgba(0,0,0,0.68) 100%);
    }
    #hook-badge {
      position: absolute; top: 260px; left: 72px; right: 140px;
      background: ${p.accent}; color: #FFFFFF; padding: 28px 36px; border-radius: 28px;
      font-family: var(--font-display, sans-serif); font-size: 56px; font-weight: 800;
      line-height: 1.12; box-shadow: 0 20px 48px rgba(0,0,0,0.28);
    }
    #caption-box {
      position: absolute; left: 72px; right: 140px; bottom: 460px;
      background: rgba(15, 15, 15, 0.86); color: #FFFFFF;
      padding: 32px 40px; border-radius: 32px; border-left: 10px solid ${p.accent};
      font-size: 46px; font-weight: 700; line-height: 1.26;
    }
    #brand-tag {
      position: absolute; left: 72px; bottom: 380px;
      color: #FFFFFF; font-size: 28px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; opacity: 0.9;
    }
  </style>
</head>
<body>
  <div id="stage">
    ${!input.hasBackgroundVideo && input.stillImagePath ? `<img class="still-bg" id="still-bg" src="${escapeHtml(input.stillImagePath)}" alt="">` : ""}
    <div class="gradient-scrim"></div>
    <div id="hook-badge">${escapeHtml(input.plan.hook)}</div>
    <div id="caption-box"></div>
    <div id="brand-tag">${escapeHtml(input.brand.brand.name)}</div>
  </div>
  <script>
    (function () {
      const overlays = ${JSON.stringify(overlays)};
      const hookEl = document.getElementById("hook-badge");
      const capEl = document.getElementById("caption-box");
      const bgEl = document.getElementById("still-bg");
      function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
      window.__seek = function (timeSeconds) {
        const ms = Math.max(0, (Number(timeSeconds) || 0) * 1000);
        document.documentElement.style.setProperty("--t", String(timeSeconds));
        // Hook banner stays for first 2.2s
        const hookVisible = ms <= 2200;
        hookEl.style.display = hookVisible ? "block" : "none";
        if (hookVisible) {
          const p = clamp(ms / 280, 0, 1);
          hookEl.style.opacity = String(p);
          hookEl.style.transform = "translateY(" + ((1 - p) * -32).toFixed(1) + "px)";
        }
        if (bgEl) {
          const zoom = 1 + clamp(ms / ${durationMs}, 0, 1) * 0.08;
          bgEl.style.transform = "scale(" + zoom.toFixed(4) + ")";
        }
        const active = overlays.find((o) => ms >= o.startMs && ms <= o.endMs) || null;
        if (!active) {
          capEl.style.display = "none";
        } else {
          capEl.style.display = "block";
          capEl.textContent = active.caption;
          const localP = clamp((ms - active.startMs) / 180, 0, 1);
          capEl.style.opacity = String(localP);
          capEl.style.transform = "translateY(" + ((1 - localP) * 20).toFixed(1) + "px)";
        }
      };
      window.__seek(0);
    })();
  </script>
</body>
</html>`;

  return { html, durationMs, transparent: input.hasBackgroundVideo };
}

/**
 * Recipe 3: `narration` — word-synchronized Turkish pill/karaoke subtitles synced to `words`
 * from `tts.ts`, paired with brand visual scenes and `window.__seek(timeSeconds)`.
 */
export function buildNarrationHtml(input: {
  brand: BrandContext;
  plan: ReelPlan;
  words: readonly WordTimestamp[];
  durationMs: number;
  heroImagePath?: string | null;
}): { html: string; durationMs: number; transparent: false } {
  const p = brandPaletteVars(input.brand);
  const durationMs = Math.max(2000, Math.round(input.durationMs));

  // Group words into readable 4-5 word subtitle chunks
  const chunks: { startMs: number; endMs: number; words: WordTimestamp[] }[] = [];
  const chunkSize = 4;
  for (let i = 0; i < input.words.length; i += chunkSize) {
    const slice = input.words.slice(i, i + chunkSize);
    if (slice.length === 0) continue;
    chunks.push({
      startMs: slice[0]?.startMs ?? 0,
      endMs: slice.at(-1)?.endMs ?? durationMs,
      words: slice,
    });
  }

  const html = `<!doctype html>
<html lang="${escapeHtml(input.brand.brand.defaultLanguage.split("-")[0] ?? "tr")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, height=1920">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    :root { --t: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 1080px; height: 1920px; overflow: hidden;
      background: ${p.bg}; color: ${p.ink}; font-family: var(--font-text, sans-serif);
    }
    #narration-root {
      position: relative; width: 1080px; height: 1920px; overflow: hidden;
      padding: 250px 140px 430px 72px; display: flex; flex-direction: column; justify-content: space-between;
    }
    .header { display: flex; flex-direction: column; gap: 20px; }
    .eyebrow {
      font-size: 28px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.14em; color: ${p.accent};
    }
    .hook-title {
      font-family: var(--font-display, sans-serif); font-size: 76px; font-weight: 800;
      line-height: 1.08; letter-spacing: -0.02em;
    }
    .visual-frame {
      width: 100%; height: 480px; border-radius: 36px; overflow: hidden;
      background: ${p.surface}; display: flex; align-items: center; justify-content: center;
      padding: 36px;
    }
    .visual-frame img { width: 100%; height: 100%; object-fit: cover; border-radius: 24px; }
    .scene-quote { font-size: 42px; font-weight: 700; line-height: 1.28; text-align: center; }
    #karaoke-bar {
      background: ${p.ink}; color: #FFFFFF; border-radius: 36px; padding: 36px 40px;
      min-height: 180px; display: flex; flex-wrap: wrap; align-items: center; gap: 16px 18px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.18);
    }
    .kw {
      font-size: 48px; font-weight: 800; line-height: 1.2; padding: 6px 16px;
      border-radius: 18px; transition: none; opacity: 0.55;
    }
    .kw.spoken { opacity: 0.92; }
    .kw.active {
      opacity: 1; background: ${p.accent}; color: #FFFFFF; transform: scale(1.06);
    }
  </style>
</head>
<body>
  <div id="narration-root">
    <div class="header">
      <p class="eyebrow">${escapeHtml(input.brand.brand.name)}</p>
      <h1 class="hook-title">${escapeHtml(input.plan.hook)}</h1>
    </div>
    <div class="visual-frame">
      ${input.heroImagePath ? `<img src="${escapeHtml(input.heroImagePath)}" alt="">` : `<p class="scene-quote" id="scene-text">${escapeHtml(input.plan.scenes[0]?.headline ?? input.plan.hook)}</p>`}
    </div>
    <div id="karaoke-bar"></div>
  </div>
  <script>
    (function () {
      const chunks = ${JSON.stringify(chunks)};
      const scenes = ${JSON.stringify(input.plan.scenes)};
      const totalMs = ${durationMs};
      const bar = document.getElementById("karaoke-bar");
      const sceneText = document.getElementById("scene-text");
      window.__seek = function (timeSeconds) {
        const ms = Math.max(0, (Number(timeSeconds) || 0) * 1000);
        document.documentElement.style.setProperty("--t", String(timeSeconds));
        if (sceneText && scenes.length > 0) {
          const idx = Math.min(scenes.length - 1, Math.floor((ms / totalMs) * scenes.length));
          sceneText.textContent = scenes[idx].headline || "";
        }
        let chunk = chunks.find((c) => ms >= c.startMs && ms <= c.endMs + 150);
        if (!chunk && chunks.length > 0) {
          chunk = ms < chunks[0].startMs ? chunks[0] : chunks[chunks.length - 1];
        }
        bar.innerHTML = "";
        if (!chunk) return;
        for (const w of chunk.words) {
          const span = document.createElement("span");
          const isActive = ms >= w.startMs && ms <= w.endMs + 40;
          const isSpoken = ms > w.endMs + 40;
          span.className = "kw" + (isActive ? " active" : isSpoken ? " spoken" : "");
          span.textContent = w.word;
          bar.appendChild(span);
        }
      };
      window.__seek(0);
    })();
  </script>
</body>
</html>`;

  return { html, durationMs, transparent: false };
}

/**
 * Static, contract-valid 1080x1920 cover HTML stored in `ContentVersion.slides[0]` for a Reel.
 * Carries `data-video-asset-id`, `data-cover-asset-id`, `data-reel-recipe`, `data-duration-ms`,
 * and base64-encoded animated composition HTML (`data-reel-composition-b64`) so both
 * `content.render` (`format: "mp4"`) and `schedule.publish` can inspect/re-render it cleanly.
 */
export function buildReelVersionSlideHtml(input: {
  brand: BrandContext;
  hook: string;
  cta: string;
  videoAssetId: string;
  coverAssetId: string;
  recipe: ReelRecipe;
  durationMs: number;
  compositionHtml: string;
}): string {
  const p = brandPaletteVars(input.brand);
  const compB64 = Buffer.from(input.compositionHtml, "utf8").toString("base64");
  return `<!doctype html>
<html lang="${escapeHtml(input.brand.brand.defaultLanguage.split("-")[0] ?? "tr")}">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="1080x1920">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    main[data-artboard] { position: relative; background: ${p.bg}; color: ${p.ink}; }
    .reel-cover-stack { display: flex; flex-direction: column; gap: 32px; }
    .reel-eyebrow { font-family: var(--font-text); font-size: 28px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: ${p.accent}; }
    .reel-headline { font-family: var(--font-display); font-size: 88px; font-weight: 800; line-height: 1.05; color: ${p.ink}; }
    .reel-cta { font-family: var(--font-text); font-size: 32px; font-weight: 600; color: ${p.muted}; }
  </style>
</head>
<body>
  <main data-artboard data-video-asset-id="${escapeHtml(input.videoAssetId)}" data-cover-asset-id="${escapeHtml(input.coverAssetId)}" data-reel-recipe="${escapeHtml(input.recipe)}" data-duration-ms="${input.durationMs}" data-reel-composition-b64="${compB64}" style="width:1080px;height:1920px">
    <div data-layer="cover-stack" data-type="group" class="reel-cover-stack" style="position:absolute; left:72px; top:480px; width:868px">
      <p data-layer="eyebrow" data-type="text" data-role="eyebrow" class="reel-eyebrow">${escapeHtml(input.brand.brand.name)}</p>
      <h1 data-layer="headline" data-type="text" data-role="headline" class="reel-headline">${escapeHtml(input.hook)}</h1>
      <p data-layer="cta" data-type="text" data-role="cta" class="reel-cta">${escapeHtml(input.cta || input.brand.brand.name)}</p>
    </div>
  </main>
</body>
</html>`;
}

export interface ExtractedReelAssets {
  videoAssetId: string | null;
  coverAssetId: string | null;
  recipe: ReelRecipe | null;
  durationMs: number | null;
  compositionHtml: string | null;
}

export function extractReelVersionAssets(
  version: Pick<ContentVersion, "slides" | "note">,
): ExtractedReelAssets {
  const slide = version.slides[0];
  const html = slide?.html ?? "";
  const readAttr = (name: string): string | null => {
    const m = new RegExp(`${name}="([^"]+)"`, "i").exec(html);
    return m?.[1] ? m[1] : null;
  };
  const videoAssetId = readAttr("data-video-asset-id");
  const coverAssetId = readAttr("data-cover-asset-id") ?? slide?.renderedAssetId ?? null;
  const rawRecipe = readAttr("data-reel-recipe");
  const recipe =
    rawRecipe && (REEL_RECIPES as readonly string[]).includes(rawRecipe)
      ? (rawRecipe as ReelRecipe)
      : null;
  const rawDur = readAttr("data-duration-ms");
  const durationMs = rawDur && /^\d+$/.test(rawDur) ? Number(rawDur) : null;
  const b64 = readAttr("data-reel-composition-b64");
  let compositionHtml: string | null = null;
  if (b64) {
    try {
      compositionHtml = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      compositionHtml = null;
    }
  }
  return { videoAssetId, coverAssetId, recipe, durationMs, compositionHtml };
}
