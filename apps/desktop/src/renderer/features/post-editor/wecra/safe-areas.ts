// Safe areas over the post's slides: the bands where the platform's UI covers a story or a Reels
// cover (the profile row, the reply bar, the caption and buttons) or the profile grid crops a feed
// post — the same insets the checks use (`@studio/design-kit/presets`, picked as the worker picks
// them: the content type's preset, else one of the slide's size). Drawn by Wecra's engine inside
// each slide frame (`Engine.setSafeAreas`, as Wecra's Social mode draws its own): canvas chrome,
// never a layer, never in an export or a save.
//
// On by default for stories and Reels, off for feed posts; "Güvenli alanlar" in the view menu (the
// zoom menu: `commands.ts`) turns them on and off for the open post.
import type { ContentType, Platform } from "@studio/contract";
import { getPreset, type PlatformPreset, presetsForSize } from "@studio/design-kit/presets";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";

/** Studio's command in Wecra's registry (the view menu's "Güvenli alanlar"). */
export const SAFE_AREAS_COMMAND = "studio.safe-areas";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The platform preset of a post's slides (the worker's `presetForVersion`). */
export function postPreset(
  type: ContentType,
  platforms: readonly Platform[],
  slide: { width: number; height: number } | null,
): PlatformPreset {
  const targets: readonly Platform[] = platforms.length ? platforms : ["instagram"];
  const platform = targets.includes("instagram")
    ? "instagram"
    : (targets.find((p) => p === "facebook" || p === "linkedin") ?? "instagram");
  const id =
    type === "story"
      ? platform === "facebook"
        ? "facebook-story"
        : "instagram-story"
      : type === "reel"
        ? "instagram-reel-cover"
        : `${platform}-feed-portrait`;
  const base = getPreset(id) ?? (getPreset("instagram-feed-portrait") as PlatformPreset);
  if (!slide || (slide.width === base.width && slide.height === base.height)) return base;
  const bySize = presetsForSize(slide.width, slide.height);
  return (
    bySize.find((p) => targets.includes(p.platform)) ??
    bySize[0] ?? { ...base, width: slide.width, height: slide.height }
  );
}

/** Shown when a post opens: stories and Reels (the platform's UI covers them), not feed posts. */
export const safeAreasByDefault = (type: ContentType): boolean =>
  type === "story" || type === "reel";

type SafeAreaUi = { studioSafeAreas?: boolean };
const uiOf = (ed: EditorController) =>
  ed.ui as unknown as {
    get(): SafeAreaUi;
    set(patch: SafeAreaUi): void;
    subscribe(listener: () => void): () => void;
  };

/** Whether the open post shows its safe areas. */
export const safeAreasOn = (ed: EditorController): boolean =>
  uiOf(ed).get().studioSafeAreas === true;

export function toggleSafeAreas(ed: EditorController): void {
  uiOf(ed).set({ studioSafeAreas: !safeAreasOn(ed) });
}

/** The post's default, once per editor (a toggle made since is kept). */
export function initSafeAreas(ed: EditorController, on: boolean): void {
  if (uiOf(ed).get().studioSafeAreas === undefined) uiOf(ed).set({ studioSafeAreas: on });
}

/** The bands' colour: Studio's warning tone, faint (the design stays readable under it). */
export const SAFE_AREA_COLOR = { r: 1, g: 0.27, b: 0.2, a: 0.18 } as const;

/** Each slide frame's bands as the engine takes them (none when they are off). */
export function safeAreaBands(
  ed: EditorController,
  insets: Insets,
): { id: string; insets: Insets; color: typeof SAFE_AREA_COLOR }[] {
  if (!safeAreasOn(ed)) return [];
  return pageFrames(ed).map((f) => ({ id: f.ref, insets, color: SAFE_AREA_COLOR }));
}

/**
 * Keeps the engine's bands in step: on the toggle and when slides are added or removed. Returns
 * the cleanup (the bands go).
 */
export function attachSafeAreas(ed: EditorController, insets: Insets): () => void {
  let last = "";
  const draw = () => {
    if (ed.engine.destroyed) return;
    const bands = safeAreaBands(ed, insets);
    const key = JSON.stringify(bands.map((b) => b.id));
    if (key === last) return;
    last = key;
    ed.engine.setSafeAreas(bands);
  };
  draw();
  const offUi = uiOf(ed).subscribe(draw);
  const offStructure = ed.store.subscribe("structure", draw);
  return () => {
    offUi();
    offStructure();
    if (!ed.engine.destroyed) ed.engine.setSafeAreas([]);
  };
}
