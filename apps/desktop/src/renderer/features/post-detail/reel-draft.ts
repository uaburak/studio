// The reel editor's working copy (port of StudioKit's ReelDraft, Domain/Reels.swift): the
// texts and timings the user changes, what blocks re-rendering, and the `reel` patch of the
// `content.render` job (`format: "mp4"`) that re-renders the video without AI — only what
// changed. Pure, so the patch is tested.
import {
  REEL_MAX_DURATION_MS,
  REEL_MIN_DURATION_MS,
  type ReelOverlay,
  type ReelRecipe,
  type ReelScene,
  type ReelSpec,
  type ReelSpecPatch,
} from "@studio/contract";

export const REEL_RECIPE_LABEL: Record<ReelRecipe, string> = {
  motion_graphics: "Hareketli grafik",
  footage_edit: "Çekim kurgusu",
  narration: "Seslendirmeli",
};

/** Closing card length the worker adds to motion graphics with a closing line. */
export const REEL_CTA_MS = 1_800;
export const MAX_SCENES = 8;
export const MAX_OVERLAYS = 40;

export interface ReelDraft {
  base: ReelSpec;
  hook: string;
  cta: string;
  scenes: ReelScene[];
  overlays: ReelOverlay[];
  narrationScript: string;
  captions: boolean;
  /** Footage length (only `footage_edit` sets it directly). */
  durationMs: number;
}

export function reelDraft(spec: ReelSpec): ReelDraft {
  return {
    base: spec,
    hook: spec.hook,
    cta: spec.cta,
    scenes: spec.scenes.map((s) => ({ ...s })),
    overlays: spec.overlays.map((o) => ({ ...o })),
    narrationScript: spec.narrationScript,
    captions: spec.captions,
    durationMs: spec.durationMs,
  };
}

/** Length of the video this draft renders (narration: until the new voice is measured). */
export function draftTotalMs(d: ReelDraft): number {
  switch (d.base.recipe) {
    case "motion_graphics": {
      const scenes = d.scenes.reduce((sum, s) => sum + s.durationMs, 0);
      const closing = d.cta.trim() ? REEL_CTA_MS : 0;
      return Math.max(REEL_MIN_DURATION_MS, scenes + closing);
    }
    case "footage_edit":
      return d.durationMs;
    case "narration":
      return d.base.durationMs;
  }
}

const blank = (text: string) => text.trim().length === 0;

/** What blocks re-rendering (Turkish; empty: it can be rendered). */
export function draftProblems(d: ReelDraft): string[] {
  const out: string[] = [];
  const total = draftTotalMs(d);
  if (d.base.recipe === "motion_graphics") {
    if (d.scenes.length === 0) out.push("En az bir sahne gerekli.");
    d.scenes.forEach((s, i) => {
      if (blank(s.headline)) out.push(`Sahne ${i + 1}: başlık boş.`);
      if (s.durationMs < 800 || s.durationMs > 20_000)
        out.push(`Sahne ${i + 1}: süre 0,8–20 sn olmalı.`);
    });
  }
  d.overlays.forEach((o, i) => {
    if (blank(o.text)) out.push(`Metin ${i + 1}: boş.`);
    if (o.endMs <= o.startMs) out.push(`Metin ${i + 1}: bitiş başlangıçtan sonra olmalı.`);
    if (o.startMs >= total) out.push(`Metin ${i + 1}: video bittikten sonra başlıyor.`);
  });
  if (d.base.recipe === "narration" && blank(d.narrationScript)) out.push("Seslendirme metni boş.");
  if (total < REEL_MIN_DURATION_MS) out.push("Video en az 3 sn olmalı.");
  if (total > REEL_MAX_DURATION_MS) out.push("Video en fazla 90 sn olabilir.");
  if ([...d.hook].length > 140) out.push("Kanca en fazla 140 karakter.");
  if ([...d.cta].length > 100) out.push("Kapanış en fazla 100 karakter.");
  return out;
}

const sameScenes = (a: ReelScene[], b: ReelScene[]) =>
  a.length === b.length &&
  a.every(
    (s, i) =>
      s.headline === b[i]?.headline &&
      s.eyebrow === b[i]?.eyebrow &&
      s.subhead === b[i]?.subhead &&
      s.durationMs === b[i]?.durationMs,
  );

const sameOverlays = (a: ReelOverlay[], b: ReelOverlay[]) =>
  a.length === b.length &&
  a.every(
    (o, i) => o.text === b[i]?.text && o.startMs === b[i]?.startMs && o.endMs === b[i]?.endMs,
  );

/** The `reel` patch of `content.render` (null when nothing changed). Arrays replace. */
export function draftPatch(d: ReelDraft): ReelSpecPatch | null {
  const p: ReelSpecPatch = {};
  const base = d.base;
  const hook = d.hook.trim();
  const cta = d.cta.trim();
  if (hook !== base.hook) p.hook = hook;
  if (cta !== base.cta) p.cta = cta;
  if (!sameScenes(d.scenes, base.scenes)) {
    p.scenes = d.scenes.map((s) => ({
      eyebrow: s.eyebrow,
      headline: s.headline.trim(),
      subhead: s.subhead,
      durationMs: s.durationMs,
    }));
  }
  if (!sameOverlays(d.overlays, base.overlays)) {
    p.overlays = d.overlays.map((o) => ({
      text: o.text.trim(),
      startMs: o.startMs,
      endMs: o.endMs,
    }));
  }
  if (d.narrationScript.trim() !== base.narrationScript.trim())
    p.narrationScript = d.narrationScript.trim();
  if (d.captions !== base.captions) p.captions = d.captions;
  if (base.recipe === "footage_edit" && d.durationMs !== base.durationMs)
    p.durationMs = d.durationMs;
  return Object.keys(p).length > 0 ? p : null;
}

export function draftIsDirty(d: ReelDraft): boolean {
  return draftPatch(d) !== null;
}

export function addOverlay(d: ReelDraft): ReelDraft {
  if (d.overlays.length >= MAX_OVERLAYS) return d;
  const total = draftTotalMs(d);
  const start = Math.min(d.overlays.at(-1)?.endMs ?? 2_400, Math.max(0, total - 1_000));
  return {
    ...d,
    overlays: [
      ...d.overlays,
      { text: "Yeni metin", startMs: start, endMs: Math.min(total, start + 2_500) },
    ],
  };
}

export function addScene(d: ReelDraft): ReelDraft {
  if (d.scenes.length >= MAX_SCENES) return d;
  return {
    ...d,
    scenes: [...d.scenes, { eyebrow: "", headline: "Yeni sahne", subhead: "", durationMs: 2_500 }],
  };
}

export function updateScene(d: ReelDraft, index: number, change: Partial<ReelScene>): ReelDraft {
  if (!d.scenes[index]) return d;
  return { ...d, scenes: d.scenes.map((s, i) => (i === index ? { ...s, ...change } : s)) };
}

export function removeScene(d: ReelDraft, index: number): ReelDraft {
  if (d.scenes.length <= 1) return d;
  return { ...d, scenes: d.scenes.filter((_, i) => i !== index) };
}

export function updateOverlay(
  d: ReelDraft,
  index: number,
  change: Partial<ReelOverlay>,
): ReelDraft {
  if (!d.overlays[index]) return d;
  return { ...d, overlays: d.overlays.map((o, i) => (i === index ? { ...o, ...change } : o)) };
}

export function removeOverlay(d: ReelDraft, index: number): ReelDraft {
  return { ...d, overlays: d.overlays.filter((_, i) => i !== index) };
}

/** Whether the draft shows the "captions" switch (spoken words exist, or could). */
export function showsCaptionsSwitch(d: ReelDraft): boolean {
  return d.base.recipe !== "motion_graphics" || d.base.words.length > 0;
}

// --- seconds in Turkish ---------------------------------------------------------------------

/** "2", "2,5" (seconds, decimal comma) for a field. */
export function secondsText(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1).replace(".", ",");
}

/** A typed "2,5" / "2.5" → 2500 ms; null when it is not a number ≥ 0. */
export function parseSeconds(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

/** "0:12", "1:30" (video length). */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
