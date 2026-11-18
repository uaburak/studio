// The brand kit as Wecra's local styles: quick picks in the Design panel (the Fill / Stroke
// "Apply styles and variables" picker, Typography's "Apply styles", the Styles list with nothing
// selected) — every colour token a colour style, every type token a text style, named
// "Marka/<token>" (Wecra folds slash names into a "Marka" folder).
//
// One copy per post document, never more: Wecra's styles live in the document (a layer links
// to a style of its own file; Wecra's team libraries would need a published library Studio
// doesn't have). When a post opens, `prepareBrandStyles` finds the styles it made before by
// their description (`studio:brand:<kind>:<token>`, kept if the user renames them), updates the
// ones whose token changed, adds the missing ones — so opening, saving and reopening a post
// never adds a second "Marka/green". Styles of tokens the brand no longer has are left alone
// (a layer may still use them). Nothing is seeded for the neutral kit (a brand without an
// approved profile has no brand colours to pick).
//
// Linking: after an import (and on every open, for documents imported before this), a layer
// whose solid fill or stroke is exactly a brand colour (opaque) gets that colour's style; a text
// whose family, weight, size, line height and letter spacing are a type token's gets that text
// style — so colours stay the brand's instead of loose hex values, and a brand colour change
// reaches them. Outside the undo history (where the document starts, not an edit).
import { type BrandTokens, colorValue } from "@studio/design-kit/brand";
import { runTool, type ToolEnv } from "@/editor/agents/mcpTools";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import type { RenderKit } from "../model/brand-kit.ts";

/** What a brand style's description starts with (its identity across opens). */
export const BRAND_STYLE_TAG = "studio:brand:";

export interface BrandStyleSpec {
  /** `color:<token>` or `type:<token>`. */
  key: string;
  kind: "FILL" | "TEXT";
  name: string;
  /** create_paint_style / create_text_style's properties. */
  props: Record<string, unknown>;
}

const WEIGHT_NAME: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

/** A weight (and italic) as a font style name, as Wecra's importer names it. */
export function fontStyleName(weight: number, italic = false): string {
  const base = WEIGHT_NAME[Math.round(weight / 100) * 100] ?? (weight < 450 ? "Regular" : "Bold");
  if (!italic) return base;
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

const em = (v: string | undefined): number => {
  const m = /^(-?[\d.]+)em$/.exec(v ?? "");
  return m ? Number(m[1]) : 0;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The kit's colour and type tokens as the styles they become (pure). */
export function brandStyleSpecs(tokens: BrandTokens): BrandStyleSpec[] {
  const colors: BrandStyleSpec[] = Object.entries(tokens.color).map(([token, c]) => ({
    key: `color:${token}`,
    kind: "FILL",
    name: `Marka/${token}`,
    props: { fills: [colorValue(c).toUpperCase()] },
  }));
  const types: BrandStyleSpec[] = Object.entries(tokens.type ?? {}).flatMap(([token, t]) => {
    const role = tokens.font[t.font];
    if (!role) return [];
    const italic = (t.style ?? role.default?.style) === "italic";
    const transform = t.transform ?? role.default?.transform;
    const props: Record<string, unknown> = {
      fontFamily: role.family,
      fontStyle: fontStyleName(t.weight, italic),
      fontSize: t.size,
      lineHeight: r2(t.size * t.leading),
      letterSpacing: r2(em(t.tracking ?? role.default?.tracking) * t.size),
    };
    if (t.weight % 100 !== 0)
      props.fontVariations = [{ axisTag: 0x77676874, axisName: "Weight", value: t.weight }];
    if (transform === "uppercase") props.textCase = "UPPER";
    else if (transform === "lowercase") props.textCase = "LOWER";
    else if (transform === "capitalize") props.textCase = "TITLE";
    return [{ key: `type:${token}`, kind: "TEXT" as const, name: `Marka/${token}`, props }];
  });
  return [...colors, ...types];
}

const envOf = (ed: EditorController): ToolEnv => ({
  ed,
  write: (_label, fn) => ed.engine.ignoringUndo(fn),
});

const resultJson = (r: { content: { type: string; text?: string }[] }): Record<string, unknown> => {
  for (const c of r.content) {
    if (c.type !== "text" || !c.text) continue;
    try {
      return JSON.parse(c.text) as Record<string, unknown>;
    } catch {
      // the next one
    }
  }
  return {};
};

/** The brand styles of the open document, by key (`color:green` → its style id). */
export function brandStyles(ed: EditorController): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of ed.engine.styles(undefined, { includeRemote: false })) {
    if (s.description?.startsWith(BRAND_STYLE_TAG))
      out.set(s.description.slice(BRAND_STYLE_TAG.length), s.id);
  }
  return out;
}

const hexOf = (c: { r: number; g: number; b: number } | undefined): string =>
  c
    ? `#${[c.r, c.g, c.b]
        .map((v) =>
          Math.round(Math.max(0, Math.min(1, v)) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`.toUpperCase()
    : "";

/**
 * The kit's styles in the document: the ones made before kept (updated when their token's value
 * changed), the missing ones added. Returns them by key.
 */
export async function seedBrandStyles(
  ed: EditorController,
  tokens: BrandTokens,
): Promise<Map<string, string>> {
  const env = envOf(ed);
  const have = brandStyles(ed);
  const styles = new Map(
    ed.engine.styles(undefined, { includeRemote: false }).map((s) => [s.id, s]),
  );
  for (const spec of brandStyleSpecs(tokens)) {
    const id = have.get(spec.key);
    if (id) {
      // Same token, new value (the brand's colour changed): the style follows, and its layers.
      const s = styles.get(id);
      const want = String((spec.props.fills as string[] | undefined)?.[0] ?? "");
      const now = s?.fillPaints?.[0] as { color?: { r: number; g: number; b: number } } | undefined;
      if (spec.kind === "FILL" && want && hexOf(now?.color) !== want.slice(0, 7))
        await runTool(env, "update_nodes", { updates: [{ nodeId: id, fills: spec.props.fills }] });
      continue;
    }
    const tool = spec.kind === "FILL" ? "create_paint_style" : "create_text_style";
    const r = await runTool(env, tool, {
      name: spec.name,
      description: `${BRAND_STYLE_TAG}${spec.key}`,
      ...spec.props,
    });
    const made = (resultJson(r).style as { id?: string } | undefined)?.id;
    if (made) have.set(spec.key, made);
  }
  return have;
}

type Solid = {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
};
type LinkNode = {
  guid: string;
  type?: string;
  fillPaints?: Solid[];
  strokePaints?: Solid[];
  styleIdForFill?: { guid?: unknown } | null;
  styleIdForStrokeFill?: { guid?: unknown } | null;
  styleIdForText?: { guid?: unknown } | null;
  fontName?: { family?: string; style?: string };
  fontSize?: number;
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
};

const hasStyle = (ref: { guid?: unknown } | null | undefined) =>
  !!ref && typeof ref === "object" && !!ref.guid && JSON.stringify(ref.guid) !== "{}";

/** The one opaque solid paint of a list ("#RRGGBB"), else null. */
function oneSolid(paints: Solid[] | undefined): string | null {
  const shown = (paints ?? []).filter((p) => p.visible !== false);
  const p = shown[0];
  if (shown.length !== 1 || p?.type !== "SOLID" || (p.opacity ?? 1) < 0.999) return null;
  return hexOf(p.color);
}

const pxOf = (v: { value?: number; units?: string } | undefined, size: number): number | null => {
  if (!v || typeof v.value !== "number") return null;
  if (v.units === "PERCENT") return (v.value / 100) * size;
  if (v.units === "RAW") return v.value * size;
  return v.value;
};

/**
 * Links the layers of the slide frames to the brand's styles: an exact brand colour (an opaque
 * solid fill / stroke) to its colour style, a text set exactly as a type token to its text style.
 * Layers with a style of their own are left as they are. Returns how many links were made.
 */
export async function linkBrandStyles(
  ed: EditorController,
  tokens: BrandTokens,
  styles: ReadonlyMap<string, string>,
): Promise<number> {
  const env = envOf(ed);
  const byColor = new Map<string, string>();
  for (const [token, c] of Object.entries(tokens.color)) {
    const id = styles.get(`color:${token}`);
    const hex = colorValue(c).toUpperCase().slice(0, 7);
    if (id && !byColor.has(hex)) byColor.set(hex, id);
  }
  const textSpecs = brandStyleSpecs(tokens).filter((s) => s.kind === "TEXT");
  const frames = pageFrames(ed).map((f) => f.ref);
  if (!frames.length) return 0;
  const nodes = ed.engine.readNodes(frames, {
    subtree: true,
    fields: [
      "type",
      "fillPaints",
      "strokePaints",
      "styleIdForFill",
      "styleIdForStrokeFill",
      "styleIdForText",
      "fontName",
      "fontSize",
      "lineHeight",
      "letterSpacing",
    ],
  }) as unknown as LinkNode[];
  const groups = new Map<string, string[]>();
  const add = (slot: string, style: string, id: string) => {
    const key = `${slot}\u0000${style}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  };
  for (const n of nodes) {
    if (frames.includes(n.guid)) continue;
    const fill = oneSolid(n.fillPaints);
    const fillStyle = fill ? byColor.get(fill) : undefined;
    if (fillStyle && !hasStyle(n.styleIdForFill)) add("fill", fillStyle, n.guid);
    const stroke = oneSolid(n.strokePaints);
    const strokeStyle = stroke ? byColor.get(stroke) : undefined;
    if (strokeStyle && !hasStyle(n.styleIdForStrokeFill)) add("stroke", strokeStyle, n.guid);
    if (n.type === "TEXT" && !hasStyle(n.styleIdForText) && typeof n.fontSize === "number") {
      const size = n.fontSize;
      const lh = pxOf(n.lineHeight, size);
      const ls = pxOf(n.letterSpacing, size) ?? 0;
      const match = textSpecs.find((s) => {
        const p = s.props;
        return (
          String(p.fontFamily).toLowerCase() === (n.fontName?.family ?? "").toLowerCase() &&
          String(p.fontStyle) === n.fontName?.style &&
          Math.abs(Number(p.fontSize) - size) < 0.5 &&
          (lh === null || Math.abs(Number(p.lineHeight) - lh) < 1) &&
          Math.abs(Number(p.letterSpacing) - ls) < 0.5
        );
      });
      const id = match ? styles.get(match.key) : undefined;
      if (id) add("text", id, n.guid);
    }
  }
  let linked = 0;
  for (const [key, ids] of groups) {
    const [slot, styleId] = key.split("\u0000");
    const r = await runTool(env, "apply_style", { nodeIds: ids, slot, styleId });
    if (!r.isError) linked += ids.length;
  }
  return linked;
}

/** The kit's styles in the opened document, and its layers linked to them (none for the neutral kit). */
export async function prepareBrandStyles(
  ed: EditorController,
  kit: Pick<RenderKit, "mode" | "tokens">,
): Promise<void> {
  if (kit.mode !== "approved") return;
  const styles = await seedBrandStyles(ed, kit.tokens);
  await linkBrandStyles(ed, kit.tokens, styles);
}
