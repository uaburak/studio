// What the post's Sohbet knows of the canvas: the layers it may name (`@` chips, the canvas
// selection) — Wecra's nodes, with the slide (top-level frame) they are on. The scope line names
// each by its Wecra id (what the agent's `canvas_edit` takes), its name and its kind.

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

const KINDS: Record<string, string> = {
  TEXT: "metin",
  FRAME: "çerçeve",
  GROUP: "grup",
  SECTION: "bölüm",
  INSTANCE: "bileşen",
  SYMBOL: "bileşen",
  VECTOR: "vektör",
  BOOLEAN_OPERATION: "vektör",
  LINE: "çizgi",
};

/** A layer's kind in plain words ("metin", "görsel", "şekil" …). */
function kindOf(node: { type?: string; fillPaints?: { type?: string; visible?: boolean }[] }) {
  if (node.fillPaints?.some((p) => p.type === "IMAGE" && p.visible !== false)) return "görsel";
  return KINDS[node.type ?? ""] ?? "şekil";
}

/** A node's slide (index of its top-level frame), name and kind, for the AI's scope line. */
export function describeNode(
  ed: EditorController,
  key: string,
): { slide: number; id: string; label: string; kind: string } | null {
  const frames = pageFrames(ed).map((f) => f.ref);
  let id: string | null = key;
  let name: string | null = null;
  let kind = "şekil";
  for (let depth = 0; id && depth < 64; depth++) {
    const raw = ed.engine.readNode(id, {
      fields: ["name", "parentIndex", "type", "textData", "fillPaints"],
    });
    if (!raw) return null;
    const node = ed.withRealType(raw) as {
      name?: string;
      type?: string;
      fillPaints?: { type?: string; visible?: boolean }[];
      textData?: { characters?: string };
      parentIndex?: { guid: string };
    };
    if (name === null) {
      name = node.name || node.textData?.characters?.slice(0, 40) || key;
      kind = depth === 0 && frames.includes(key) ? "kare" : kindOf(node);
    }
    const slide = frames.indexOf(id);
    if (slide >= 0) return { slide, id: key, label: name, kind };
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
