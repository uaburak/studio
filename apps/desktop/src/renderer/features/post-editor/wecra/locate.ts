// A check's place on the canvas (E6, "Göster"): the slide is the page's top-level frame in
// reading order (as the version's slides are), the layer is found through what the version says
// about it — a canvas version's slide HTML carries each described layer's Wecra node id
// (`data-wecra-id`, from its facts); an imported (AI) version's layers keep their contract id as
// Studio's plugin data (`import.ts markLayers`) or as their name. The layer (else the slide) is
// selected and the view zooms to it, as Wecra's own Find does.
import type { CheckRef } from "@studio/contract";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { LAYER_KEY, STUDIO_PLUGIN } from "./facts.ts";

/** `data-layer="…"`'s Wecra node id in a canvas slide's HTML, or null. */
export function wecraIdOfLayer(html: string | null | undefined, layer: string): string | null {
  if (!html || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("[data-layer]"))
    if (el.getAttribute("data-layer") === layer) return el.getAttribute("data-wecra-id") || null;
  return null;
}

type FoundNode = {
  guid: string;
  name?: string;
  pluginData?: { pluginID?: string; key?: string; value?: string }[];
};

const markedLayer = (n: FoundNode): string | null => {
  const entry = n.pluginData?.find((e) => e.pluginID === STUDIO_PLUGIN && e.key === LAYER_KEY);
  if (!entry?.value) return null;
  try {
    const layer = (JSON.parse(entry.value) as { layer?: unknown }).layer;
    return typeof layer === "string" ? layer : null;
  } catch {
    return null;
  }
};

/** The Wecra node a check's place names on the canvas: the layer, else its slide's frame. */
export function checkTarget(
  ed: EditorController,
  ref: CheckRef,
  slideHtml?: string | null,
): string | null {
  if (ref.slide === null) return null;
  const frame = pageFrames(ed)[ref.slide];
  if (!frame) return null;
  if (!ref.layer) return frame.ref;
  const nodes = ed.engine.readNodes([frame.ref], {
    subtree: true,
    fields: ["name", "pluginData"],
  }) as unknown as FoundNode[];
  const inFrame = new Set(nodes.map((n) => n.guid));
  const byId = wecraIdOfLayer(slideHtml, ref.layer);
  if (byId && inFrame.has(byId)) return byId;
  const layer = ref.layer;
  const found =
    nodes.find((n) => n.guid !== frame.ref && markedLayer(n) === layer) ??
    nodes.find((n) => n.guid !== frame.ref && n.name === layer);
  return found?.guid ?? frame.ref;
}

/** Selects the check's layer (else its slide) and zooms to it. False: not on this canvas. */
export function showCheck(ed: EditorController, ref: CheckRef, slideHtml?: string | null): boolean {
  if (ed.engine.destroyed) return false;
  const target = checkTarget(ed, ref, slideHtml);
  if (!target) return false;
  ed.engine.setSelection([target]);
  ed.engine.command("ZOOM_TO_SELECTION");
  return true;
}
