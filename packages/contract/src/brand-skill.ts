import { z } from "zod";
import { slugify } from "./brand.ts";
import {
  AgentEffort,
  AgentModel,
  EntityId,
  nonEmptyUpdate,
  PageQuery,
  pageOf,
  Timestamp,
} from "./common.ts";

/**
 * Brand skills ("Skill'ler" under Marka Kiti): Markdown instruction documents the agent follows
 * for one brand, like Wecra's `mtm` / `partner` skills: formats with their pixel layouts, tone,
 * do / don't lists. Each skill has a kebab-case name (unique per brand), a one-line
 * description and a Markdown body; it is versioned (every change of name, description or body
 * stores a new version) and can be switched off without deleting it.
 *
 * Chat turns and design generations of the brand get its *enabled* skills in their prompt
 * (within a size budget). `brand.skill_draft` drafts a new (disabled) skill with AI from the
 * brand's kit, profile and sample posts.
 *
 * Stored in D1 (`brand_skills` + `brand_skill_versions`),
 * `/api/brands/{brandId}/skills[/{skillId}[/versions[/{version}[/restore]]]]`.
 */

export const MAX_BRAND_SKILLS = 30;
/** Characters of a skill body (Markdown). */
export const MAX_SKILL_BODY_CHARS = 40_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;

/** kebab-case, like a SKILL.md name: `mtm`, `carousel-formati`. */
export const BrandSkillName = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");
const SkillDescription = z.string().trim().max(MAX_SKILL_DESCRIPTION_CHARS);
const SkillBody = z.string().max(MAX_SKILL_BODY_CHARS);
const SkillNote = z.string().trim().max(500);

/** Where a version came from: typed by hand, drafted by AI, or an older version brought back. */
export const BrandSkillOrigin = z
  .enum(["manual", "ai_draft", "restore"])
  .meta({ id: "BrandSkillOrigin" });
export type BrandSkillOrigin = z.infer<typeof BrandSkillOrigin>;

export const BrandSkill = z
  .object({
    id: EntityId,
    brandId: EntityId,
    name: z.string(),
    description: z.string(),
    /** Markdown instructions. */
    body: z.string(),
    /** Disabled skills are kept but never reach the agent. */
    enabled: z.boolean(),
    /** Current version (1, 2, 3 … per skill). */
    version: z.number().int().min(1),
    /** Origin of the current version. */
    origin: BrandSkillOrigin,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "BrandSkill" });
export type BrandSkill = z.infer<typeof BrandSkill>;

export const BrandSkillVersion = z
  .object({
    id: EntityId,
    skillId: EntityId,
    brandId: EntityId,
    version: z.number().int().min(1),
    name: z.string(),
    description: z.string(),
    body: z.string(),
    origin: BrandSkillOrigin,
    /** What changed, in the user's words ("" when none). */
    note: z.string(),
    /** The `brand.skill_draft` job that wrote it, for AI drafts. */
    jobId: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "BrandSkillVersion" });
export type BrandSkillVersion = z.infer<typeof BrandSkillVersion>;

export const BrandSkillCreate = z
  .object({
    name: BrandSkillName,
    description: SkillDescription.default(""),
    body: SkillBody,
    enabled: z.boolean().default(true),
    /** `ai_draft` when the worker stores a drafted skill. */
    origin: z.enum(["manual", "ai_draft"]).default("manual"),
    note: SkillNote.default(""),
    jobId: z.string().max(128).optional(),
  })
  .meta({ id: "BrandSkillCreate" });
export type BrandSkillCreate = z.input<typeof BrandSkillCreate>;

/**
 * A change of `name`, `description` or `body` stores a new version (when the text really
 * changed); `enabled` alone does not.
 */
export const BrandSkillUpdate = z
  .object({
    name: BrandSkillName.optional(),
    description: SkillDescription.optional(),
    body: SkillBody.optional(),
    enabled: z.boolean().optional(),
    note: SkillNote.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "BrandSkillUpdate" });
export type BrandSkillUpdate = z.input<typeof BrandSkillUpdate>;

export const BrandSkillListQuery = PageQuery;
export type BrandSkillListQuery = z.input<typeof BrandSkillListQuery>;

/** Oldest first (the order they were added in). */
export const BrandSkillList = pageOf(BrandSkill, "BrandSkillList");
export type BrandSkillList = z.infer<typeof BrandSkillList>;

export const BrandSkillVersionListQuery = PageQuery;
export type BrandSkillVersionListQuery = z.input<typeof BrandSkillVersionListQuery>;

/** Newest first. */
export const BrandSkillVersionList = pageOf(BrandSkillVersion, "BrandSkillVersionList");
export type BrandSkillVersionList = z.infer<typeof BrandSkillVersionList>;

export const SkillVersionNumber = z.coerce.number().int().min(1);

// --- brand.skill_draft ---------------------------------------------------------------------------

/**
 * `brand.skill_draft`: AI reads the brand's kit (palette, fonts, notes), its current profile
 * (DESIGN / VOICE / facts), sample posts and approved content, and stores a new skill —
 * disabled, origin `ai_draft` — for the user to review and switch on.
 */
export const BrandSkillDraftPayload = z
  .object({
    /** What the skill should cover, in the user's words ("carousel formatı", "ürün postları"). */
    focus: z.string().trim().max(2_000).optional(),
    /** Name of the new skill; the model picks one when absent (made unique if taken). */
    name: BrandSkillName.optional(),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
  })
  .meta({ id: "BrandSkillDraftPayload" });
export type BrandSkillDraftPayload = z.infer<typeof BrandSkillDraftPayload>;
export type BrandSkillDraftPayloadInput = z.input<typeof BrandSkillDraftPayload>;

/** Short label for job summaries and notes: `mtm v3`. */
export function brandSkillLabel(skill: Pick<BrandSkill, "name" | "version">): string {
  return `${skill.name} v${skill.version}`;
}

/** `ad`, `ad-2`, `ad-3` …: the first name not in `taken`. */
export function uniqueSkillName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = slugify(base).slice(0, 44).replace(/-+$/g, "") || "skill";
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) {
    const candidate = `${clean}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
