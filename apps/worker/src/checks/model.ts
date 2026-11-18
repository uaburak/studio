/**
 * The model pass of the generation checks: ONE cheap structured call over the post's text
 * (caption + slide texts, no images) for what rules cannot judge — Turkish spelling and
 * grammar, the brand voice / skill rules, product names against Ürünler, claims against the
 * brand facts.
 *
 * Gemini Flash-Lite through the direct API when a key is configured (spend recorded),
 * otherwise Claude Haiku at low effort; neither available → the model checks are `skipped`.
 * Findings must quote text that really occurs in the post (anything else is dropped), and
 * their place (`caption`, `slide-2:headline`) must exist.
 */
import {
  type BrandProduct,
  CHECK_CATALOG,
  type CheckId,
  type CheckStrictness,
  type ContentCheckResult,
} from "@studio/contract";
import { z } from "zod";
import type { AgentDeps } from "../agent.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import { callGeminiJson, getGeminiApiKey } from "../gemini/json-call.ts";
import { resolveGeminiModelId } from "../gemini/models.ts";
import type { SlideText } from "./deterministic.ts";
import { excerpt } from "./text.ts";

export interface ModelCheckInput {
  brandName: string;
  language: string;
  /** VOICE.md (tone) of the brand profile. */
  voice: string;
  /** The brand's enabled skills (Markdown), already selected and clipped. */
  skills: string;
  /** Brand facts (statements, forbidden claims, allowed numbers) or null. */
  facts: unknown | null;
  products: readonly BrandProduct[];
  content: {
    type: string;
    platforms: readonly string[];
    title: string;
    brief: string;
    caption: string;
  };
  slides: readonly { index: number; texts: readonly SlideText[] }[];
  /** The model checks to run (enabled ones). */
  checks: readonly CheckId[];
  strictness: CheckStrictness;
}

export interface ModelCallRequest {
  label: string;
  system: string;
  content: ClaudeContentBlock[];
  schema: object;
  signal: AbortSignal;
}

export type ModelCaller = (req: ModelCallRequest) => Promise<{ output: unknown; model: string }>;

const Finding = z.object({
  check: z.string(),
  severity: z.enum(["warn", "fail"]).catch("warn"),
  where: z.string().default("caption"),
  quote: z.string().default(""),
  message: z.string().min(1),
  suggestion: z.string().default(""),
});
const Output = z.object({ findings: z.array(z.unknown()).default([]) });

export function modelCheckSchema(checks: readonly CheckId[]): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "severity", "where", "quote", "message", "suggestion"],
          properties: {
            check: { type: "string", enum: [...checks] },
            severity: { type: "string", enum: ["warn", "fail"] },
            where: {
              type: "string",
              description: '"caption" or "slide-N:layer-id" exactly as given in the input.',
            },
            quote: { type: "string", description: "The offending text, copied verbatim." },
            message: { type: "string", description: "Short Turkish explanation." },
            suggestion: { type: "string", description: "Short Turkish fix, or empty." },
          },
        },
      },
    },
  };
}

const CHECK_PROMPTS: Record<string, string> = {
  "text.language":
    "Turkish spelling, grammar, punctuation and typos in the caption and the slide texts (TDK conventions; ç ğ ı İ ö ş ü must be right; 'de/da', 'ki', 'mi' spelled correctly). Do not flag style choices, brand or product names, hashtags, deliberate uppercase or short headline fragments.",
  "brand.voice":
    "The copy breaks the brand voice (VOICE) or a rule of the brand skills (SKILLS): forbidden words or phrasings, wrong form of address (sen/siz), tone, do / don't lists, emoji or punctuation rules.",
  "accuracy.products":
    "A product name or product detail that does not match PRODUCTS: a misspelt or invented product name, a product that is not in the list presented as the brand's, a wrong category or property. Only when PRODUCTS is not empty.",
  "accuracy.claims":
    "A claim that FACTS do not support or that FACTS forbid: numbers, doses, percentages, prices, guarantees, certificates, health / yield / performance promises, comparisons with competitors, superlatives ('en iyi', '1 numara').",
};

export function buildModelCheckSystem(checks: readonly CheckId[]): string {
  return [
    "You review the text of one social media post of a brand before a human approves it.",
    "Check ONLY these checks:",
    ...checks.map((c) => `- ${c}: ${CHECK_PROMPTS[c] ?? CHECK_CATALOG[c].description}`),
    "",
    "Rules:",
    "- Report only real problems; when a check finds nothing, return no finding for it. An empty list is a good answer.",
    "- `quote` is the offending text copied VERBATIM from the input (a few words, not whole paragraphs).",
    '- `where` is "caption" or the slide text\'s label exactly as given ("slide-2:headline").',
    '- severity "fail" only for clear errors (a misspelling, a wrong product name, a forbidden or unsupported claim, a broken skill rule); "warn" for doubtful cases.',
    "- `message` and `suggestion` are short and in Turkish. The suggestion is the corrected text when there is one.",
    "- Never invent facts about the brand; judge only against VOICE, SKILLS, PRODUCTS and FACTS.",
  ].join("\n");
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[… kısaltıldı]`;

export function buildModelCheckPrompt(input: ModelCheckInput): string {
  const products = input.products.slice(0, 40).map((p) => ({
    name: p.name,
    ...(p.category ? { category: p.category } : {}),
    ...(p.description ? { description: excerpt(p.description, 200) } : {}),
    ...(p.tags.length ? { tags: p.tags } : {}),
    ...(p.notes ? { notes: excerpt(p.notes, 300) } : {}),
  }));
  const slides = input.slides.flatMap((s) =>
    s.texts.map((t) => `slide-${s.index + 1}:${t.layer}${t.role ? ` (${t.role})` : ""}: ${t.text}`),
  );
  return [
    `BRAND: ${input.brandName} (language: ${input.language})`,
    `POST: ${input.content.type} for ${input.content.platforms.join(", ") || "instagram"} — "${input.content.title}"`,
    `BRIEF (context only, not checked): ${clip(input.content.brief, 1_500)}`,
    "",
    "<voice>",
    clip(input.voice || "(none)", 3_000),
    "</voice>",
    "<skills>",
    clip(input.skills || "(none)", 5_000),
    "</skills>",
    "<products>",
    products.length ? JSON.stringify(products) : "(none)",
    "</products>",
    "<facts>",
    input.facts ? clip(JSON.stringify(input.facts), 4_000) : "(none)",
    "</facts>",
    "",
    "TEXT TO CHECK",
    "caption:",
    input.content.caption || "(empty)",
    "",
    "slide texts:",
    ...(slides.length ? slides : ["(none)"]),
  ].join("\n");
}

const norm = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();

/** Validated findings → results (problems), plus one `pass` row per check without findings. */
export function modelResults(
  raw: unknown,
  input: ModelCheckInput,
  model: string,
): ContentCheckResult[] {
  const parsed = Output.safeParse(raw);
  const findings = parsed.success ? parsed.data.findings : [];
  const texts = new Map<string, { slide: number; layer: string; text: string }>();
  for (const s of input.slides)
    for (const t of s.texts)
      texts.set(`slide-${s.index + 1}:${t.layer}`, {
        slide: s.index,
        layer: t.layer,
        text: t.text,
      });
  const caption = norm(input.content.caption);
  const allText = norm(
    [input.content.caption, ...[...texts.values()].map((t) => t.text)].join(" "),
  );
  const out: ContentCheckResult[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const finding = Finding.safeParse(f);
    if (!finding.success) continue;
    const { check, where, quote, message, suggestion } = finding.data;
    if (!input.checks.includes(check as CheckId)) continue;
    const id = check as CheckId;
    const q = norm(quote);
    // Hallucination guard: the quote must occur in the post (voice / claims may be general).
    if (q && !allText.includes(q)) continue;
    if (!q && (id === "text.language" || id === "accuracy.products")) continue;
    const target = texts.get(where.trim());
    let refs: ContentCheckResult["refs"] = [];
    if (target) refs = [{ slide: target.slide, layer: target.layer.slice(0, 64) }];
    else if (q && !caption.includes(q)) {
      // Wrong label: find the slide text that has the quote.
      const hit = [...texts.values()].find((t) => norm(t.text).includes(q));
      if (hit) refs = [{ slide: hit.slide, layer: hit.layer.slice(0, 64) }];
    }
    const key = `${id}|${q}|${refs[0]?.layer ?? "caption"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let status: "warn" | "fail" = finding.data.severity;
    if (input.strictness === "relaxed") status = "warn";
    const tail = suggestion.trim() ? ` Öneri: ${excerpt(suggestion, 200)}` : "";
    out.push({
      checkId: id,
      category: CHECK_CATALOG[id].category,
      status,
      message: `${excerpt(message, 300)}${tail}`.slice(0, 600),
      refs,
      evidence: {
        rule: "model",
        ...(quote ? { quote: excerpt(quote, 200) } : {}),
        ...(suggestion ? { suggestion: excerpt(suggestion, 300) } : {}),
        where: refs.length ? "slide" : "caption",
        model,
      },
      source: "model",
      fixable: false,
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * The caller for the model pass: Gemini Flash-Lite with a key, else Claude Haiku (low effort)
 * when Claude is signed in; `null` when neither can run. A Gemini error falls back to Claude.
 */
export function checkModelCaller(deps: AgentDeps, jobId: string | null): ModelCaller | null {
  const { settings } = deps;
  const apiKey = getGeminiApiKey(settings);
  const claudeReady = () => deps.health().state === "ok";
  const viaClaude: ModelCaller = async (req) => {
    const res = await deps.gate.call(
      {
        label: req.label,
        system: req.system,
        content: req.content,
        schema: req.schema,
        model: "haiku",
        effort: "low",
        timeoutMs: Math.min(settings.claudeTimeoutMs, 180_000),
        signal: req.signal,
      },
      {},
    );
    return { output: res.output, model: res.model ?? "haiku" };
  };
  if (apiKey) {
    const modelId = resolveGeminiModelId("gemini-flash-lite", settings.geminiModels);
    return async (req) => {
      try {
        const res = await callGeminiJson({
          apiKey,
          modelId,
          system: req.system,
          content: req.content,
          schema: req.schema,
          effort: "low",
          signal: req.signal,
          ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
          onUsage: geminiUsageSink(deps.aiUsage, { kind: "check", jobId: jobId ?? undefined }),
        });
        return { output: res.output, model: res.model };
      } catch (error) {
        if (req.signal.aborted || !claudeReady()) throw error;
        deps.logger.warn(`checks: Gemini failed, using Claude: ${(error as Error).message}`);
        return viaClaude(req);
      }
    };
  }
  return claudeReady() ? viaClaude : null;
}

/** Runs the model pass; throws when the call fails (the caller marks the checks skipped). */
export async function runModelChecks(
  input: ModelCheckInput,
  caller: ModelCaller,
  options: { label: string; signal: AbortSignal; timeoutMs?: number },
): Promise<{ results: ContentCheckResult[]; model: string }> {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 180_000),
  ]);
  const res = await caller({
    label: options.label,
    system: buildModelCheckSystem(input.checks),
    content: [{ type: "text", text: buildModelCheckPrompt(input) }],
    schema: modelCheckSchema(input.checks),
    signal,
  });
  return { results: modelResults(res.output, input, res.model), model: res.model };
}
