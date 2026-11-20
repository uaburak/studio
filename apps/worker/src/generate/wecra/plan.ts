/**
 * What the Wecra design agent answers, and how it becomes canvas jobs: each pass returns Wecra's
 * own design operations (its MCP write tools with their arguments, as JSON text so any model's
 * structured output can carry them); they are checked here (a known tool, an object of
 * arguments, the job's limits) before a `canvas.create` / `canvas.apply` runs them.
 */
import {
  CANVAS_EDIT_TOOLS,
  type CanvasEditTool,
  type CanvasOperation,
  MAX_CANVAS_OPERATIONS,
  MAX_JOB_PAYLOAD_BYTES,
} from "@studio/contract";

/** Room left in a job's payload for the operations (the rest: version, note, ids). */
const MAX_OPERATIONS_BYTES = MAX_JOB_PAYLOAD_BYTES - 6_000;

const OPERATION_SCHEMA = {
  type: "object",
  required: ["tool", "argsJson"],
  properties: {
    tool: { type: "string", enum: [...CANVAS_EDIT_TOOLS] },
    argsJson: {
      type: "string",
      description: "The tool's arguments as one JSON object (Wecra's / Figma Plugin API names).",
    },
  },
} as const;

/** The first design (the slides on a blank canvas, the caption). */
export const designSchema = {
  type: "object",
  required: ["rationale", "slides", "caption", "hashtags"],
  properties: {
    rationale: { type: "string", description: "The idea, the grid, the type scale (short)." },
    slides: {
      type: "array",
      description: "One entry per slide, in reading order (slide 1 first).",
      items: {
        type: "object",
        required: ["slide", "operations"],
        properties: {
          slide: { type: "integer", description: "1-based; its frame is `frame:<slide>`." },
          operations: { type: "array", items: OPERATION_SCHEMA },
        },
      },
    },
    caption: { type: "string", description: "The caption without hashtags." },
    hashtags: { type: "array", items: { type: "string" } },
  },
} as const;

/** A critique of the rendered slides and the operations that fix it. */
export const critiqueSchema = {
  type: "object",
  required: ["verdict", "issues", "operations"],
  properties: {
    verdict: { type: "string", enum: ["ok", "fix"] },
    issues: { type: "array", items: { type: "string" } },
    operations: { type: "array", items: OPERATION_SCHEMA },
  },
} as const;

export interface ParsedOperations {
  operations: CanvasOperation[];
  /** Operations left out and why (said back to the model in the next pass). */
  problems: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The model's operation list → checked canvas operations (bad ones dropped, said why). */
export function readOperations(raw: unknown, at = "operations"): ParsedOperations {
  const operations: CanvasOperation[] = [];
  const problems: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  let bytes = 0;
  for (const [i, item] of list.entries()) {
    const where = `${at}[${i}]`;
    if (!isRecord(item)) {
      problems.push(`${where}: nesne değil.`);
      continue;
    }
    const tool = item.tool;
    if (typeof tool !== "string" || !(CANVAS_EDIT_TOOLS as readonly string[]).includes(tool)) {
      problems.push(`${where}: bilinmeyen araç ${JSON.stringify(tool)}.`);
      continue;
    }
    let args: unknown = item.args;
    if (args === undefined && typeof item.argsJson === "string") {
      try {
        args = JSON.parse(item.argsJson);
      } catch {
        problems.push(`${where} (${tool}): argsJson geçerli JSON değil.`);
        continue;
      }
    }
    if (!isRecord(args)) {
      problems.push(`${where} (${tool}): argümanlar bir nesne olmalı.`);
      continue;
    }
    if (operations.length >= MAX_CANVAS_OPERATIONS) {
      problems.push(`${where}: en çok ${MAX_CANVAS_OPERATIONS} işlem; gerisi uygulanmadı.`);
      break;
    }
    const size = JSON.stringify(args).length;
    if (bytes + size > MAX_OPERATIONS_BYTES) {
      problems.push(`${where}: işlemler çok büyük; buradan sonrası uygulanmadı.`);
      break;
    }
    bytes += size;
    operations.push({ tool: tool as CanvasEditTool, args });
  }
  return { operations, problems };
}

export interface DesignPlan extends ParsedOperations {
  slides: number;
  rationale: string;
  caption: string;
  hashtags: string[];
}

/**
 * The first design: the slides (clamped to `bounds`; operations of a slide past the last are
 * dropped), every operation in slide order, the caption.
 */
export function readDesign(raw: unknown, bounds: { min: number; max: number }): DesignPlan {
  const out = isRecord(raw) ? raw : {};
  const slides = (Array.isArray(out.slides) ? out.slides : [])
    .filter(isRecord)
    .map((s, i) => ({ slide: typeof s.slide === "number" ? Math.round(s.slide) : i + 1, s }))
    .sort((a, b) => a.slide - b.slide);
  const count = Math.min(bounds.max, Math.max(bounds.min, slides.length));
  const all: unknown[] = [];
  const problems: string[] = [];
  for (const { slide, s } of slides) {
    if (slide < 1 || slide > count) {
      problems.push(`slayt ${slide}: postta ${count} kare var; bu kare atlandı.`);
      continue;
    }
    if (Array.isArray(s.operations)) all.push(...s.operations);
  }
  const parsed = readOperations(all);
  return {
    slides: count,
    operations: parsed.operations,
    problems: [...problems, ...parsed.problems],
    rationale: typeof out.rationale === "string" ? out.rationale.slice(0, 2_000) : "",
    caption: typeof out.caption === "string" ? out.caption.trim() : "",
    hashtags: normalizeHashtags(out.hashtags),
  };
}

export interface Critique extends ParsedOperations {
  ok: boolean;
  issues: string[];
}

export function readCritique(raw: unknown): Critique {
  const out = isRecord(raw) ? raw : {};
  const parsed = readOperations(out.operations);
  const issues = (Array.isArray(out.issues) ? out.issues : [])
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.trim().slice(0, 400))
    .slice(0, 12);
  return {
    ...parsed,
    issues,
    ok: out.verdict === "ok" || parsed.operations.length === 0,
  };
}

/** `#hasat`, `hasat`, `#Hasat Bayramı` → `#hasat`, `#HasatBayramı` (unique, at most 30). */
export function normalizeHashtags(raw: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "string") continue;
    const tag = item
      .replace(/^#+/, "")
      .replace(/[\s#]+/g, "")
      .trim();
    if (!tag || !/^[\p{L}\p{N}_]+$/u.test(tag)) continue;
    const full = `#${tag}`;
    if (!out.some((t) => t.toLocaleLowerCase("tr") === full.toLocaleLowerCase("tr")))
      out.push(full);
    if (out.length >= 30) break;
  }
  return out;
}

/** The caption as stored: the text, a blank line, the hashtags (as the HTML pipeline writes it). */
export function captionWithHashtags(caption: string, hashtags: readonly string[]): string {
  const body = caption.trim();
  const tags = hashtags.join(" ");
  return [body, tags].filter(Boolean).join("\n\n").slice(0, 10_000);
}
