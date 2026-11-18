// What the post's Sohbet knows of the canvas: the layers it may name (`@` chips, the canvas
// selection) — Wecra's nodes, with the slide (top-level frame) they are on.

import { useMemo } from "react";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { useSelection } from "@/engine/hooks";

export interface ChatLayer {
  key: string;
  label: string;
  /** "Kare 2" */
  detail: string;
}

export interface ChatLayers {
  /** The canvas selection (node ids). */
  selection: readonly string[];
  label(key: string): string;
  search(query: string): ChatLayer[];
  deselect(key: string): void;
}

/** A node's slide (index of its top-level frame) and name, for the AI's scope line. */
export function describeNode(
  ed: EditorController,
  key: string,
): { slide: number; id: string; label: string } | null {
  const frames = pageFrames(ed).map((f) => f.ref);
  let id: string | null = key;
  let name: string | null = null;
  for (let depth = 0; id && depth < 64; depth++) {
    const node = ed.engine.readNode(id, {
      fields: ["name", "parentIndex", "type", "textData"],
    }) as {
      name?: string;
      textData?: { characters?: string };
      parentIndex?: { guid: string };
    } | null;
    if (!node) return null;
    if (name === null) name = node.name || node.textData?.characters?.slice(0, 40) || key;
    const slide = frames.indexOf(id);
    if (slide >= 0) return { slide, id: key, label: name };
    id = node.parentIndex?.guid ?? null;
  }
  return null;
}

/** Every layer on the slides (for `@`), in slide order. */
function allLayers(ed: EditorController): ChatLayer[] {
  const out: ChatLayer[] = [];
  pageFrames(ed).forEach((frame, index) => {
    const nodes = ed.engine.readNodes([frame.ref], { subtree: true, fields: ["name", "textData"] });
    for (const n of nodes as {
      guid: string;
      name?: string;
      textData?: { characters?: string };
    }[]) {
      if (n.guid === frame.ref) continue;
      out.push({
        key: n.guid,
        label: n.name || n.textData?.characters?.slice(0, 40) || n.guid,
        detail: `Kare ${index + 1}`,
      });
    }
  });
  return out;
}

export function useChatLayers(ed: EditorController): ChatLayers {
  const selection = useSelection(ed.store).refs;
  return useMemo(
    () => ({
      selection,
      label: (key) => describeNode(ed, key)?.label ?? key,
      search: (query) => {
        const q = query.toLocaleLowerCase("tr-TR");
        return allLayers(ed)
          .filter((l) => !q || l.label.toLocaleLowerCase("tr-TR").includes(q))
          .slice(0, 8);
      },
      deselect: (key) => void ed.engine.setSelection(selection.filter((k) => k !== key)),
    }),
    [ed, selection],
  );
}

/** Before the editor is up: nothing selected, nothing to name. */
export const NO_LAYERS: ChatLayers = {
  selection: [],
  label: (key) => key,
  search: () => [],
  deselect: () => {},
};
