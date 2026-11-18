// Fonts a slide uses that Wecra's text engine did not have (E9): such a text is drawn — and would
// be published — in the fallback (Inter). The draft keeps the canvas as it is, but no version is
// made from it and the post is not approved while a used font is missing:
//
//   - at a save, from the canvas facts read with the export (facts.ts `fonts[].missing`): the
//     definitive check (session.ts);
//   - while editing, from Wecra's own "Missing fonts" (its font service's missing names among the
//     fonts the slide frames name): the title bar's warning and Onayla's reason;
//   - a version made on the canvas, from the facts in its slide HTML (what its PNG was drawn with).
import { type CanvasFacts, readCanvas } from "@studio/design-kit/canvas";
import { useEffect, useState } from "react";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { fonts } from "@/engine/fonts";

/** The families the facts mark missing (each once, in slide order). */
export function missingFamilies(facts: readonly (CanvasFacts | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of facts)
    for (const font of f?.fonts ?? []) {
      const key = font.family.toLowerCase();
      if (!font.missing || seen.has(key)) continue;
      seen.add(key);
      out.push(font.family);
    }
  return out;
}

/** "Eksik font: X. Mac'e yükleyin ya da marka kitine ekleyin." (null: none missing). */
export function missingFontMessage(families: readonly string[]): string | null {
  if (families.length === 0) return null;
  return `Eksik font: ${families.join(", ")}. Mac'e yükleyin ya da marka kitine ekleyin.`;
}

/** The families a canvas version's renders were drawn without (from its slide HTML's facts). */
export function versionMissingFonts(
  version: { slides: readonly { html: string }[] } | null | undefined,
): string[] {
  if (!version) return [];
  return missingFamilies(
    version.slides.map((s) => {
      const canvas = readCanvas(s.html);
      return canvas.kind === "facts" ? canvas.facts : null;
    }),
  );
}

const normStyle = (s: string) => s.replace(/[\s_-]/g, "").toLowerCase();
const fontKey = (family: string, style: string) => `${family.toLowerCase()}\n${normStyle(style)}`;

type FontsEngine = {
  destroyed: boolean;
  documentFonts?: (refs: readonly string[]) => { family: string; style: string }[];
  on?: (type: "DOCUMENT_CHANGED", cb: () => void) => () => void;
};

/** The families the slide frames use that Wecra reported missing (Wecra's "Missing fonts"). */
export function canvasMissingFonts(ed: EditorController): string[] {
  const engine = ed.engine as unknown as FontsEngine;
  if (engine.destroyed || typeof engine.documentFonts !== "function") return [];
  const frames = pageFrames(ed).map((f) => f.ref);
  if (frames.length === 0) return [];
  const missing = new Set(fonts.missing().map((m) => fontKey(m.family, m.style)));
  if (missing.size === 0) return [];
  const out: string[] = [];
  for (const used of engine.documentFonts(frames))
    if (missing.has(fontKey(used.family, used.style)) && !out.includes(used.family))
      out.push(used.family);
  return out;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** `canvasMissingFonts`, read again a moment after each change and each font answer. */
export function useCanvasMissingFonts(ed: EditorController | null): string[] {
  const [families, setFamilies] = useState<string[]>([]);
  useEffect(() => {
    if (!ed) {
      setFamilies((prev) => (prev.length ? [] : prev));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      timer = undefined;
      try {
        const next = canvasMissingFonts(ed);
        setFamilies((prev) => (same(prev, next) ? prev : next));
      } catch {
        // the editor is going
      }
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(read, 250);
    };
    read();
    const engine = ed.engine as unknown as FontsEngine;
    const offs = [
      typeof engine.on === "function" ? engine.on("DOCUMENT_CHANGED", schedule) : () => {},
      fonts.onMissingChange(schedule),
      fonts.onChange(schedule),
    ];
    return () => {
      for (const off of offs) off();
      clearTimeout(timer);
    };
  }, [ed]);
  return families;
}
