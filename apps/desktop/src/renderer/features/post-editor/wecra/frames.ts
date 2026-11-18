// The canvas's slide frames and whether they can be saved as this post's slides (E15). The
// slides are the page's top-level frames in reading order (Wecra's `pageFrames`), so a frame
// changes the post:
//
// - a hidden frame would silently drop its slide: saving stops and says which one to show or
//   delete;
// - every frame has the post's format (`postFormat`: the size its version was made in — feed
//   1080×1350 or square 1080×1080; a story 1080×1920): a frame of another size is not saved;
// - the count fits the post type: a carousel 2–20 frames (add, duplicate, delete freely within
//   that); a single post or a story one frame — the type of a post can't change, so a second
//   frame there is explained instead of saved.
import { ARTBOARDS, type ContentType, MAX_ARTBOARD_PX, SLIDE_LIMITS } from "@studio/contract";
import type { EditorController } from "@/editor/controller";

export interface FrameSize {
  width: number;
  height: number;
}

export interface CanvasFrame extends FrameSize {
  guid: string;
  name: string;
  visible: boolean;
}

const SLIDE_TYPES = new Set(["FRAME", "SYMBOL", "INSTANCE"]);

/** Every top-level frame of the page (hidden ones too; groups are not frames). */
export function canvasFrames(ed: EditorController): CanvasFrame[] {
  const page = ed.engine.readNode(ed.store.page, { childIds: true }) as {
    childIds?: string[];
  } | null;
  const ids = page?.childIds ?? [];
  return (
    ed.engine.readNodes(ids, { fields: ["type", "name", "visible", "size", "resizeToFit"] }) as {
      guid: string;
      type?: string;
      name?: string;
      visible?: boolean;
      size?: { x: number; y: number };
      resizeToFit?: boolean;
    }[]
  )
    .map((n) => ed.withRealType(n as never) as typeof n)
    .filter((n) => SLIDE_TYPES.has(n.type ?? "") && !n.resizeToFit)
    .map((n) => ({
      guid: n.guid,
      name: n.name ?? "",
      visible: n.visible !== false,
      width: Math.round(n.size?.x ?? 0),
      height: Math.round(n.size?.y ?? 0),
    }));
}

/**
 * The size every frame of the post must have: a story's is the vertical one; any other post keeps
 * the size its version was made in (one of the feed sizes, else what the version has).
 */
export function postFormat(type: ContentType, base: FrameSize | null | undefined): FrameSize {
  if (type === "story" || type === "reel") return { ...ARTBOARDS.vertical };
  if (base && base.width >= 1 && base.height >= 1)
    return { width: base.width, height: base.height };
  return { ...ARTBOARDS.portrait };
}

const size = (s: FrameSize) => `${s.width}×${s.height}`;

/** Why these frames can't be saved as the post's slides (null: they can). */
export function frameBlocker(
  type: ContentType,
  frames: readonly CanvasFrame[],
  format: FrameSize | null,
): string | null {
  const hidden = frames.filter((f) => !f.visible);
  if (hidden.length)
    return hidden.length === 1
      ? `“${hidden[0]?.name}” gizli. Gizli kare kaydedilmez (sürümden düşerdi): göster ya da sil.`
      : `${hidden.length} kare gizli (${hidden.map((f) => `“${f.name}”`).join(", ")}). Gizli kare kaydedilmez: göster ya da sil.`;
  const shown = frames.filter((f) => f.visible);
  const limits = SLIDE_LIMITS[type];
  if (shown.length === 0) return "Tuvalde kare yok.";
  if (limits.max === 1 && shown.length > 1)
    return `${type === "story" ? "Story" : "Bu post"} tek kare; tuvalde ${shown.length} çerçeve var. Postun türü değişmez: fazla çerçeveyi sil. Birden çok kare için yeni bir carousel postu oluştur.`;
  if (shown.length < limits.min)
    return `Carousel en az ${limits.min} kare ister; tuvalde ${shown.length} çerçeve var. Bir kare ekle (çoğalt ya da yeni çerçeve).`;
  if (shown.length > limits.max)
    return `En fazla ${limits.max} kare olabilir; tuvalde ${shown.length} çerçeve var. Fazlasını sil.`;
  const bad = shown.find(
    (f) => f.width < 1 || f.height < 1 || f.width > MAX_ARTBOARD_PX || f.height > MAX_ARTBOARD_PX,
  );
  if (bad) return `“${bad.name}”: kare 1–${MAX_ARTBOARD_PX} px olmalı (${size(bad)}).`;
  if (format) {
    const off = shown.find((f) => f.width !== format.width || f.height !== format.height);
    if (off)
      return `“${off.name}” ${size(off)} px; bu postun kareleri ${size(format)} px. Çerçeveyi bu ölçüye getir.`;
  }
  return null;
}
