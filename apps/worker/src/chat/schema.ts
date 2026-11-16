/**
 * Structured output of one chat turn: the reply (streamed into the chat while it
 * is written), what to do next (nothing, propose a plan, ask a question) and the
 * plan / question itself. The JSON schema goes to `--json-schema`; the zod schema
 * re-validates and normalises what came back before anything is written.
 */
import {
  checkPlanPeriod,
  isValidAlias,
  MAX_PLAN_ITEMS,
  MAX_PLAN_PERIOD_DAYS,
  type MessagePartInput,
  type PlanProposalPut,
  scanAliasTokens,
} from "@studio/contract";
import { z } from "zod";

export const CHAT_CONTENT_TYPES = ["post", "carousel", "story", "reel"] as const;
export const CHAT_PLATFORMS = ["instagram", "facebook", "linkedin"] as const;
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

/** JSON schema handed to the CLI. `reply` comes first so it streams before the plan. */
export const CHAT_TURN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "action"],
  properties: {
    reply: {
      type: "string",
      description: "Kullanıcıya gösterilecek Türkçe yanıt (düz metin, kısa).",
    },
    action: {
      type: "string",
      enum: ["none", "plan", "question"],
      description:
        "plan: içerik planı öner; question: eksik bilgi için tek soru sor; none: yalnızca yanıt.",
    },
    plan: {
      type: "object",
      additionalProperties: false,
      required: ["title", "periodStart", "periodEnd", "summary", "items"],
      properties: {
        brandId: {
          type: "string",
          description: "Yalnızca konuşmanın markası yoksa: listeden seçilen markanın id'si.",
        },
        title: { type: "string" },
        periodStart: { type: "string", pattern: DATE },
        periodEnd: { type: "string", pattern: DATE },
        summary: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 31,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "date",
              "platforms",
              "contentType",
              "title",
              "brief",
              "pillar",
              "imageSlot",
              "imageBrief",
              "imageAliases",
            ],
            properties: {
              date: { type: "string", pattern: DATE },
              platforms: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: { type: "string", enum: [...CHAT_PLATFORMS] },
              },
              contentType: { type: "string", enum: [...CHAT_CONTENT_TYPES] },
              title: { type: "string" },
              brief: { type: "string" },
              pillar: { type: "string" },
              imageSlot: { type: "string", enum: ["none", "user_upload", "ai_generate"] },
              imageBrief: { type: "string" },
              imageAliases: {
                type: "array",
                items: { type: "string" },
                description:
                  "Kullanıcının bu post için istediği @takma adlar (@ olmadan), yoksa [].",
              },
            },
          },
        },
      },
    },
    question: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "mode", "options", "allowText"],
      properties: {
        prompt: { type: "string" },
        mode: { type: "string", enum: ["single", "multiple", "text"] },
        options: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9_-]{1,40}$" },
              label: { type: "string" },
              description: { type: "string" },
            },
          },
        },
        allowText: { type: "boolean" },
      },
    },
  },
} as const;

const trimmed = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

export const ChatPlanItemOutput = z.object({
  date: z.string().nullable().optional(),
  platforms: z.array(z.enum(CHAT_PLATFORMS)).min(1),
  contentType: z.enum(CHAT_CONTENT_TYPES),
  title: trimmed(200),
  brief: trimmed(20_000),
  pillar: trimmed(120).optional(),
  imageSlot: z.enum(["none", "user_upload", "ai_generate"]),
  imageBrief: trimmed(3_800).optional(),
  imageAliases: z.array(z.string()).default([]),
});
export type ChatPlanItemOutput = z.infer<typeof ChatPlanItemOutput>;

export const ChatTurnOutput = z.object({
  reply: z.string(),
  action: z.enum(["none", "plan", "question"]),
  plan: z
    .object({
      brandId: z.string().optional(),
      title: trimmed(200),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      summary: trimmed(20_000),
      items: z.array(ChatPlanItemOutput).min(1),
    })
    .optional(),
  question: z
    .object({
      prompt: trimmed(2_000),
      mode: z.enum(["single", "multiple", "text"]),
      options: z
        .array(
          z.object({
            id: z.string(),
            label: trimmed(200),
            description: z.string().optional(),
          }),
        )
        .default([]),
      allowText: z.boolean().default(false),
    })
    .optional(),
});
export type ChatTurnOutput = z.infer<typeof ChatTurnOutput>;

/** Alias names (current and previous) the plan may reference. */
export interface KnownAlias {
  alias: string;
  previousAliases?: readonly string[];
}

export interface PlanConversion {
  plan: PlanProposalPut;
  /** What was fixed or dropped on the way (for logs and the job output). */
  notes: string[];
}

/**
 * Turn the model's plan into the API's `PUT plan` body. Fixes instead of failing
 * where it can: dates outside the period become null, unknown aliases are dropped,
 * duplicate platforms removed, items above the limit cut.
 * The aliases an item should use are written at the start of its image brief as
 * `@alias` mentions (the plan item has no alias field yet; `content.generate`
 * resolves them against the conversation's aliases).
 */
export function convertPlan(
  plan: NonNullable<ChatTurnOutput["plan"]>,
  options: { aliases: readonly KnownAlias[]; brandId?: string | undefined; attempt?: number },
): PlanConversion {
  const notes: string[] = [];
  let { periodStart, periodEnd } = plan;
  if (periodEnd < periodStart) {
    [periodStart, periodEnd] = [periodEnd, periodStart];
    notes.push("period start/end swapped");
  }
  const periodError = checkPlanPeriod(periodStart, periodEnd);
  if (periodError) {
    const start = new Date(`${periodStart}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + MAX_PLAN_PERIOD_DAYS - 1);
    periodEnd = start.toISOString().slice(0, 10);
    notes.push(`period shortened: ${periodError}`);
  }
  const known = new Map<string, string>();
  for (const a of options.aliases) {
    known.set(a.alias, a.alias);
    for (const old of a.previousAliases ?? []) if (!known.has(old)) known.set(old, a.alias);
  }
  const items = plan.items.slice(0, MAX_PLAN_ITEMS).map((item, i) => {
    let date = item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : null;
    if (date && (date < periodStart || date > periodEnd)) {
      notes.push(`item ${i + 1}: date ${date} outside the period, cleared`);
      date = null;
    }
    const aliases: string[] = [];
    for (const raw of item.imageAliases) {
      const name = raw.trim().replace(/^@/, "").toLowerCase();
      const current = isValidAlias(name) ? known.get(name) : undefined;
      if (current) {
        if (!aliases.includes(current)) aliases.push(current);
      } else {
        notes.push(`item ${i + 1}: unknown alias @${name} dropped`);
      }
    }
    let imageBrief = item.imageBrief?.trim() ?? "";
    let imageSlot = item.imageSlot;
    if (aliases.length > 0) {
      // Same token rules as the server's @mention parser: "(@image)" counts, "a@image" does not.
      const written = new Set(
        scanAliasTokens(imageBrief).map((t) => known.get(t.alias) ?? t.alias),
      );
      const missing = aliases.filter((a) => !written.has(a));
      if (missing.length > 0) {
        imageBrief = `${missing.map((a) => `@${a}`).join(" ")}${imageBrief ? ` — ${imageBrief}` : ""}`;
      }
      if (imageSlot === "none") imageSlot = "user_upload";
    }
    return {
      date,
      platforms: [...new Set(item.platforms)],
      contentType: item.contentType,
      title: item.title || `Post ${i + 1}`,
      brief: item.brief,
      pillar: item.pillar ? item.pillar : null,
      imageSlot,
      imageBrief: imageBrief ? imageBrief.slice(0, 4_000) : null,
    };
  });
  if (plan.items.length > MAX_PLAN_ITEMS) notes.push(`items cut to ${MAX_PLAN_ITEMS}`);
  return {
    plan: {
      ...(options.attempt ? { attempt: options.attempt } : {}),
      ...(options.brandId ? { brandId: options.brandId } : {}),
      title: plan.title,
      periodStart,
      periodEnd,
      summary: plan.summary,
      status: "proposed",
      items,
    },
    notes,
  };
}

/** The model's question as a `question` part; null when it is not a valid question. */
export function toQuestionPart(
  question: NonNullable<ChatTurnOutput["question"]>,
  questionId: string,
): Extract<MessagePartInput, { type: "question" }> | null {
  if (!question.prompt) return null;
  const seen = new Set<string>();
  const options = question.options
    .map((o, i) => {
      let id =
        o.id
          .toLowerCase()
          .replace(/[^a-z0-9_.:-]/g, "-")
          .slice(0, 64) || `opt-${i + 1}`;
      if (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      return {
        id,
        label: o.label || id,
        description: o.description?.trim() ? o.description.trim().slice(0, 1_000) : null,
      };
    })
    .filter((o) => o.label.length > 0);
  let mode = question.mode;
  if (mode !== "text" && options.length < 2) mode = "text";
  return {
    type: "question",
    questionId,
    prompt: question.prompt,
    mode,
    options: mode === "text" ? [] : options.slice(0, 12),
    allowText: mode === "text" ? false : question.allowText,
  };
}
