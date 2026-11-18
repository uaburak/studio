// Platform safe areas over the artboards (design-kit's platform presets, the same numbers the
// linter's `safe-area` rule checks) and the collision warnings: text and logos must stay inside;
// images and shapes may bleed.
import type { ContentType, Platform } from "@studio/contract";
import { PLATFORM_PRESETS, type PlatformPreset } from "@studio/design-kit/presets";
import type { EditorLayer } from "./document.ts";
import { aabb, type MeasuredLayer, type Rect } from "./geometry.ts";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SafeBand {
  edge: "top" | "right" | "bottom" | "left";
  size: number;
  /** "Profil ve süre çubuğu · 250 px" */
  label: string;
}

export interface SafeAreaView {
  preset: PlatformPreset;
  insets: Insets;
  /** The bands platform UI covers (stories, reels); feed posts only have the margin. */
  bands: SafeBand[];
  /** The profile grid's 3:4 crop of a 4:5 post: what stays visible (artboard px). */
  gridCrop: Rect | null;
}

const BAND_LABEL: Record<PlatformPreset["surface"], Partial<Record<SafeBand["edge"], string>>> = {
  feed: {},
  document: {},
  story: { top: "Profil ve süre çubuğu", bottom: "Yanıt alanı" },
  "reel-cover": { top: "Profil", bottom: "Açıklama ve ses", right: "Butonlar" },
};

/** The preset that fits a post: its size, its type's surface and its first platform. */
export function presetFor(
  type: ContentType,
  platforms: readonly Platform[],
  size: { width: number; height: number },
  override?: string | null,
): PlatformPreset | null {
  const all = Object.values(PLATFORM_PRESETS) as PlatformPreset[];
  if (override) {
    const chosen = all.find((p) => p.id === override);
    if (chosen && chosen.width === size.width && chosen.height === size.height) return chosen;
  }
  const surface: PlatformPreset["surface"] =
    type === "story" ? "story" : type === "reel" ? "reel-cover" : "feed";
  const sized = all.filter((p) => p.width === size.width && p.height === size.height);
  const platform = platforms[0] ?? "instagram";
  return (
    sized.find((p) => p.platform === platform && p.surface === surface) ??
    sized.find((p) => p.surface === surface) ??
    sized.find((p) => p.platform === platform) ??
    sized[0] ??
    null
  );
}

/** Presets an artboard can be previewed as (same size), for the format menu. */
export function presetsForSlide(size: { width: number; height: number }): PlatformPreset[] {
  return (Object.values(PLATFORM_PRESETS) as PlatformPreset[]).filter(
    (p) => p.width === size.width && p.height === size.height,
  );
}

export function safeAreaView(preset: PlatformPreset): SafeAreaView {
  const insets = { ...preset.safeArea };
  const labels = BAND_LABEL[preset.surface];
  const bands: SafeBand[] = [];
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const label = labels[edge];
    if (label) bands.push({ edge, size: insets[edge], label: `${label} · ${insets[edge]} px` });
  }
  // Instagram's profile grid shows a 4:5 post cropped to 3:4 (about 34 px off each side).
  const gridCrop =
    preset.surface === "feed" && preset.ratio === "4:5"
      ? (() => {
          const w = (preset.height * 3) / 4;
          const x = (preset.width - w) / 2;
          return { x, y: 0, w, h: preset.height };
        })()
      : null;
  return { preset, insets, bands, gridCrop };
}

export interface Collision {
  key: string;
  layerId: string;
  /** The edges whose band the layer reaches into. */
  edges: SafeBand["edge"][];
  /** How far it reaches, per edge (px). */
  overlap: Partial<Record<SafeBand["edge"], number>>;
  /** The smallest move that brings it inside (px), or null when it does not fit at all. */
  fix: { dx: number; dy: number } | null;
  message: string;
}

const CHECKED: ReadonlySet<EditorLayer["type"]> = new Set(["text", "logo"]);

/** Text and logo layers (visible, not hidden) reaching outside the safe area. */
export function collisions(
  layers: readonly EditorLayer[],
  measure: Record<string, MeasuredLayer> | null,
  size: { width: number; height: number },
  view: SafeAreaView,
): Collision[] {
  if (!measure) return [];
  const { insets } = view;
  const safe = {
    x: insets.left,
    y: insets.top,
    w: size.width - insets.left - insets.right,
    h: size.height - insets.top - insets.bottom,
  };
  const out: Collision[] = [];
  for (const layer of layers) {
    if (!CHECKED.has(layer.type) || layer.hidden) continue;
    const m = measure[layer.id];
    if (!m?.visible || m.box.w <= 0 || m.box.h <= 0) continue;
    // Inside a group the group is what moves; its children are still checked.
    const r = aabb(m.box);
    const overlap: Collision["overlap"] = {};
    const tol = 0.5;
    if (r.y < safe.y - tol) overlap.top = Math.round(safe.y - r.y);
    if (r.x < safe.x - tol) overlap.left = Math.round(safe.x - r.x);
    if (r.x + r.w > safe.x + safe.w + tol) overlap.right = Math.round(r.x + r.w - safe.x - safe.w);
    if (r.y + r.h > safe.y + safe.h + tol) overlap.bottom = Math.round(r.y + r.h - safe.y - safe.h);
    const edges = Object.keys(overlap) as SafeBand["edge"][];
    if (edges.length === 0) continue;
    out.push({
      key: layer.key,
      layerId: layer.id,
      edges,
      overlap,
      fix: moveInside(r, safe),
      message: collisionMessage(view, edges, layer.type),
    });
  }
  return out;
}

/** The smallest move bringing `r` inside `safe`; null when it is larger than the safe area. */
export function moveInside(r: Rect, safe: Rect): { dx: number; dy: number } | null {
  if (r.w > safe.w + 0.5 || r.h > safe.h + 0.5) return null;
  const dx =
    r.x < safe.x ? safe.x - r.x : r.x + r.w > safe.x + safe.w ? safe.x + safe.w - r.x - r.w : 0;
  const dy =
    r.y < safe.y ? safe.y - r.y : r.y + r.h > safe.y + safe.h ? safe.y + safe.h - r.y - r.h : 0;
  return { dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 };
}

function collisionMessage(
  view: SafeAreaView,
  edges: SafeBand["edge"][],
  type: EditorLayer["type"],
): string {
  const what = type === "logo" ? "Logo" : "Bu metin";
  const band = view.bands.find((b) => edges.includes(b.edge));
  const surface =
    view.preset.surface === "story"
      ? "hikâyede"
      : view.preset.surface === "reel-cover"
        ? "Reels kapağında"
        : "akışta";
  if (band) {
    const platform = view.preset.platform === "facebook" ? "Facebook" : "Instagram";
    return `${platform} ${surface} ${band.edge === "top" ? "üst" : band.edge === "bottom" ? "alt" : "sağ"} ${band.size} px'i ${band.label.split(" · ")[0]?.toLocaleLowerCase("tr-TR")} için kapatır. ${what} orada kalıyor.`;
  }
  return `${what} ${view.insets.top} px kenar boşluğunun dışına taşıyor; profil ızgarası ve ekran kenarları kesebilir.`;
}
