// The AI's edits of a canvas document, made with Wecra's own design operations: each operation
// is one of Wecra's MCP write tools (`update_nodes`, `create_nodes`, `set_properties`,
// `delete_nodes`, `duplicate_nodes`, `reparent_nodes`, `set_auto_layout`, `place_image`) with its
// arguments, run by Wecra's tool runner (`editor/agents/mcpTools.ts runTool`) on the document —
// the same code Wecra's agents use. Each write is one step of an engine actor (Wecra's
// `AgentTurns`), never the user's selection. Every result is Wecra's own read back: what was
// applied, refused, what did not take.
//
// Studio's one addition: a picture is named by `assetId` (a picture of the brand's media), never
// by a file path; its bytes are read here and handed to Wecra as `data`.
import {
  CANVAS_EDIT_TOOLS,
  type CanvasOperation,
  type CanvasOperationResult,
} from "@studio/contract";
import { runTool, type ToolEnv } from "@/editor/agents/mcpTools";
import { AgentTurns } from "@/editor/agents/turns";
import type { EditorController } from "@/editor/controller";

const ALLOWED = new Set<string>(CANVAS_EDIT_TOOLS);
const MAX_SUMMARY = 1_500;

export interface OperationDeps {
  /** A picture's bytes (an asset of the brand's media). */
  fetchAsset(assetId: string): Promise<Uint8Array>;
}

/** Wecra's tool environment on a document nobody is editing: each write one actor step. */
export function headlessToolEnv(ed: EditorController): ToolEnv & { dispose(): void } {
  const turns = new AgentTurns(ed);
  return {
    ed,
    write: (_label, fn, refs) => turns.write(null, "Studio", fn, refs ?? []),
    dispose: () => turns.dispose(),
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** The asset is an SVG (a brand logo): its text, else null. */
export function svgText(bytes: Uint8Array): string | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, "").trimStart();
  if (!/^<(\?xml|svg|!--|!DOCTYPE svg)/i.test(head)) return null;
  const text = new TextDecoder().decode(bytes);
  return /<svg[\s>]/i.test(text) ? text : null;
}

const SVG = Symbol("svg");

/**
 * An image argument (`{assetId, scaleMode}`) as Wecra takes it (`{data, scaleMode, name}`). An
 * SVG asset (a brand logo) is not a picture to Wecra: it comes back marked, and the layer becomes
 * the SVG's vector layers (create_nodes `svg`).
 */
async function imageArg(value: unknown, deps: OperationDeps, at: string): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  if ("path" in v) throw new Error(`${at}: dosya yolu kullanılamaz; görseli assetId ile ver.`);
  if (typeof v.assetId !== "string" || !v.assetId) return value;
  const { assetId, ...rest } = v;
  const bytes = await deps.fetchAsset(assetId);
  const svg = svgText(bytes);
  if (svg !== null) return { [SVG]: svg };
  return { name: "Görsel", ...rest, data: base64(bytes) };
}

/** The operation's arguments with every picture named by `assetId` read into `data`. */
export async function resolveImages(
  op: CanvasOperation,
  deps: OperationDeps,
): Promise<Record<string, unknown>> {
  const args = { ...op.args };
  if (op.tool === "place_image") {
    if ("path" in args) throw new Error("place_image: dosya yolu kullanılamaz; assetId ver.");
    if (typeof args.assetId === "string" && args.assetId) {
      const { assetId, ...rest } = args;
      const bytes = await deps.fetchAsset(assetId);
      if (svgText(bytes) !== null)
        throw new Error(
          "place_image: bu görsel bir SVG (logo); create_nodes {nodes: [{image: {assetId}, x, y, width}]} ile vektör katman olarak ekle.",
        );
      return { name: "Görsel", ...rest, data: base64(bytes) };
    }
    return args;
  }
  const list = op.tool === "create_nodes" ? "nodes" : op.tool === "update_nodes" ? "updates" : null;
  if (!list || !Array.isArray(args[list])) return args;
  const walk = async (specs: unknown[], at: string): Promise<unknown[]> =>
    Promise.all(
      specs.map(async (spec, i) => {
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
        const out = { ...(spec as Record<string, unknown>) };
        if (out.image !== undefined) {
          const image = await imageArg(out.image, deps, `${at}[${i}].image`);
          const svg = (image as { [SVG]?: string } | null)?.[SVG];
          if (typeof svg === "string" && list === "nodes") {
            // Wecra's createNodeFromSvg: a frame the SVG's size holding its vectors.
            delete out.image;
            delete out.type;
            out.svg = svg;
          } else if (typeof svg === "string") {
            throw new Error(`${at}[${i}].image: SVG bir dolgu olamaz; create_nodes ile ekle.`);
          } else out.image = image;
        }
        if (Array.isArray(out.children))
          out.children = await walk(out.children, `${at}[${i}].children`);
        return out;
      }),
    );
  args[list] = await walk(args[list] as unknown[], list);
  return args;
}

/** Wecra's result as one line: its summary (or error text) and the layers it touched. */
function resultOf(
  tool: CanvasOperation["tool"],
  r: { content: { type: string; text?: string }[]; isError?: boolean; touched?: string[] },
): CanvasOperationResult {
  const text = r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  let summary = text;
  const touched = new Set(r.touched ?? []);
  try {
    const parsed = JSON.parse(text) as {
      summary?: unknown;
      created?: { id?: unknown }[];
      copies?: { id?: unknown }[];
      deleted?: unknown;
      nodeId?: unknown;
    };
    if (typeof parsed.summary === "string") summary = parsed.summary;
    else if (typeof parsed.deleted === "number")
      summary = `${tool}: ${parsed.deleted} katman silindi.`;
    for (const c of [...(parsed.created ?? []), ...(parsed.copies ?? [])])
      if (typeof c.id === "string") touched.add(c.id);
  } catch {
    // Wecra answered in prose (an error): kept as it is.
  }
  return {
    tool,
    ok: !r.isError,
    summary:
      summary.slice(0, MAX_SUMMARY) || (r.isError ? `${tool} başarısız.` : `${tool} uygulandı.`),
    touched: [...touched].slice(0, 200),
  };
}

/** Runs the operations in order (one failing does not stop the others). */
export async function applyOperations(
  ed: EditorController,
  operations: readonly CanvasOperation[],
  deps: OperationDeps,
): Promise<CanvasOperationResult[]> {
  const env = headlessToolEnv(ed);
  const results: CanvasOperationResult[] = [];
  try {
    for (const op of operations) {
      if (!ALLOWED.has(op.tool)) {
        results.push({
          tool: op.tool,
          ok: false,
          summary: `${op.tool} kullanılamaz.`,
          touched: [],
        });
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = await resolveImages(op, deps);
      } catch (e) {
        results.push({
          tool: op.tool,
          ok: false,
          summary: e instanceof Error ? e.message : String(e),
          touched: [],
        });
        continue;
      }
      results.push(resultOf(op.tool, await runTool(env, op.tool, args)));
    }
  } finally {
    env.dispose();
  }
  return results;
}
