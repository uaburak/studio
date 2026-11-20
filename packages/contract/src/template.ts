import { z } from "zod";
import {
  AgentEffort,
  AgentModel,
  EntityId,
  PageQuery,
  Platform,
  pageOf,
  Timestamp,
} from "./common.ts";
import { Content, ContentType, EditorDocument, Slide } from "./content.ts";
import { SlotImageRequest } from "./generation.ts";
import { Job } from "./job.ts";

/*
 * Brand templates (N9) and repurposing (N10).
 *
 * A template is an approved (or published) post saved as a layout: its slides stay exactly as
 * they were, and its text layers and image slots become fillable fields named from their roles
 * (headline, body, cta, slot …). `kind` says what the layout is: `html` — design-contract slides
 * (fields are `data-layer` ids; filling patches those layers); `canvas` — a version saved from
 * the post editor's canvas (a Wecra document; fields name its Wecra layers and filling is a
 * `canvas.apply` job on a copy of the template's document). A new post made from a template is a
 * `content.generate` job whose payload carries `template` (`TemplateFill`).
 *
 * Repurposing makes a story (1080×1920) or a Reels video from a post: a new post linked to its
 * source (`Content.source`), made by a `content.generate` job whose payload carries `repurpose`.
 */

/** Statuses a post must be in to become a template (it was approved). */
export const TEMPLATE_SOURCE_STATUSES = [
  "approved",
  "scheduled",
  "publishing",
  "published",
] as const satisfies readonly Content["status"][];

/** Content types a template can be made from (a reel is a video, not a layout). */
export const TEMPLATE_CONTENT_TYPES = [
  "post",
  "carousel",
  "story",
] as const satisfies readonly ContentType[];

export const MAX_TEMPLATE_FIELDS = 80;
export const MAX_TEMPLATE_TEXT = 2_000;

export const TemplateKind = z.enum(["html", "canvas"]).meta({ id: "TemplateKind" });
export type TemplateKind = z.infer<typeof TemplateKind>;

export const TemplateFieldKind = z.enum(["text", "image"]).meta({ id: "TemplateFieldKind" });
export type TemplateFieldKind = z.infer<typeof TemplateFieldKind>;

/** Field keys: kebab-case, unique in a template (`headline`, `body-2`, `slot`). */
export const TEMPLATE_FIELD_KEY = /^[a-z][a-z0-9-]{0,47}$/;
export const TemplateFieldKey = z
  .string()
  .regex(TEMPLATE_FIELD_KEY, "field keys are kebab-case, at most 48 characters");

const Box = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().min(0),
  h: z.number().finite().min(0),
});

/**
 * How a text field's layer was laid out in the source, for fitting a new text: its box, font
 * size, line height, the average advance of one character and its line count (canvas: from the
 * facts Wecra's text engine laid out; HTML: the box from the measured render, the rest unknown).
 */
export const TemplateTextMetrics = z
  .object({
    box: Box,
    /** px */
    fontSize: z.number().positive().nullable(),
    /** px */
    lineHeight: z.number().positive().nullable(),
    /** Average advance of one character at `fontSize`, px. */
    charWidth: z.number().positive().nullable(),
    lines: z.number().int().min(0),
    /** Canvas: the box is fixed (`none`), grows down (`height`) or hugs the text. */
    autoResize: z.enum(["none", "height", "width-and-height"]).nullable(),
  })
  .meta({ id: "TemplateTextMetrics" });
export type TemplateTextMetrics = z.infer<typeof TemplateTextMetrics>;

export const TemplateField = z
  .object({
    key: TemplateFieldKey,
    /** Turkish, shown in the fill form ("Başlık", "Görsel · Kare 2"). */
    label: z.string().min(1).max(80),
    kind: TemplateFieldKind,
    /** The contract role of its layer (`headline`, `body`, `cta` …; `null`: none). */
    role: z.string().max(32).nullable(),
    /** 0-based slide. */
    slide: z.number().int().min(0).max(19),
    /** The layer: its `data-layer` id (HTML; also the canvas slide HTML's layer id). */
    layer: z.string().min(1).max(64),
    /** Canvas: the Wecra layer the field fills (`12:345`). */
    nodeId: z.string().max(64).nullable(),
    /** What the layer is: a text, an image slot or a picture. */
    layerType: z.enum(["text", "slot", "image"]),
    /** The source's text (a text field) or picture file (`/media/…`, an image field). */
    example: z.string().max(MAX_TEMPLATE_TEXT),
    /** About how many characters fit at the source's size (a hint; auto-fit decides). */
    maxChars: z.number().int().min(1).max(5_000).nullable(),
    /** Auto-fit never goes below this font size (px). */
    minFontSize: z.number().positive().nullable(),
    /** The source text had more than one line. */
    multiline: z.boolean(),
    /** Image fields: the slot's `W:H`. */
    ratio: z.string().max(16).nullable(),
    metrics: TemplateTextMetrics.nullable(),
    /** A longer text shrinks its font (down to `minFontSize`) instead of overflowing. */
    autoFit: z.boolean(),
    /** Locked: the field keeps the template's own text or picture (it is never filled). */
    locked: z.boolean(),
  })
  .meta({ id: "TemplateField" });
export type TemplateField = z.infer<typeof TemplateField>;

export const TemplateSource = z
  .object({
    /** The post it was made from (null once that post was deleted for good). */
    contentId: EntityId.nullable(),
    version: z.number().int().min(1),
    title: z.string(),
  })
  .meta({ id: "TemplateSource" });
export type TemplateSource = z.infer<typeof TemplateSource>;

export const ContentTemplate = z
  .object({
    id: EntityId,
    brandId: EntityId,
    name: z.string(),
    description: z.string(),
    kind: TemplateKind,
    contentType: ContentType,
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    slideCount: z.number().int().min(1),
    fields: z.array(TemplateField).max(MAX_TEMPLATE_FIELDS),
    /** The source version's renders, one per slide (the template's preview). */
    previewAssetIds: z.array(EntityId.nullable()),
    source: TemplateSource,
    /** Canvas templates: the Wecra document a new post's copy starts from. */
    editorDocument: EditorDocument.nullable(),
    /** Posts made from it so far (still there, trash included). */
    useCount: z.number().int().min(0),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ContentTemplate" });
export type ContentTemplate = z.infer<typeof ContentTemplate>;

/** A template with its slides (what the worker fills). */
export const ContentTemplateDetail = ContentTemplate.extend({
  slides: z.array(Slide),
}).meta({ id: "ContentTemplateDetail" });
export type ContentTemplateDetail = z.infer<typeof ContentTemplateDetail>;

const TemplateName = z.string().trim().min(1).max(120);
const TemplateDescription = z.string().max(1_000);

/**
 * `POST /api/templates`: save an approved / published post as a template of its brand. The
 * version defaults to the approved one.
 */
export const ContentTemplateCreate = z
  .object({
    contentId: EntityId,
    version: z.number().int().min(1).optional(),
    /** Default: the post's title. */
    name: TemplateName.optional(),
    description: TemplateDescription.optional(),
  })
  .meta({ id: "ContentTemplateCreate" });
export type ContentTemplateCreate = z.input<typeof ContentTemplateCreate>;

export const TemplateFieldUpdate = z
  .object({
    key: TemplateFieldKey,
    label: z.string().trim().min(1).max(80).optional(),
    autoFit: z.boolean().optional(),
    locked: z.boolean().optional(),
    minFontSize: z.number().min(8).max(400).nullable().optional(),
  })
  .meta({ id: "TemplateFieldUpdate" });
export type TemplateFieldUpdate = z.input<typeof TemplateFieldUpdate>;

export const ContentTemplateUpdate = z
  .object({
    name: TemplateName.optional(),
    description: TemplateDescription.optional(),
    /** Changes to some fields (by key); the rest stay. */
    fields: z.array(TemplateFieldUpdate).max(MAX_TEMPLATE_FIELDS).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.fields !== undefined,
    "at least one field is required",
  )
  .meta({ id: "ContentTemplateUpdate" });
export type ContentTemplateUpdate = z.input<typeof ContentTemplateUpdate>;

export const ContentTemplateListQuery = PageQuery.extend({
  kind: TemplateKind.optional(),
  contentType: ContentType.optional(),
});
export type ContentTemplateListQuery = z.input<typeof ContentTemplateListQuery>;

export const ContentTemplateList = pageOf(ContentTemplate, "ContentTemplateList");
export type ContentTemplateList = z.infer<typeof ContentTemplateList>;

// --- filling ------------------------------------------------------------------------------

/**
 * How a new post's fields get their texts: `manual` — the values given (a missing value keeps
 * the template's text); `ai` — the model writes every unlocked text field (and the caption) from
 * the brief, the given values stay as they are.
 */
export const TemplateFillMode = z.enum(["manual", "ai"]).meta({ id: "TemplateFillMode" });
export type TemplateFillMode = z.infer<typeof TemplateFillMode>;

const FieldValues = z
  .record(z.string(), z.string().max(MAX_TEMPLATE_TEXT))
  .refine((v) => Object.keys(v).length <= MAX_TEMPLATE_FIELDS, "too many values");
const FieldImages = z
  .record(z.string(), EntityId)
  .refine((v) => Object.keys(v).length <= MAX_TEMPLATE_FIELDS, "too many images");

/** The `template` part of a `content.generate` payload. */
export const TemplateFill = z
  .object({
    templateId: EntityId,
    /** Text by field key. */
    values: FieldValues.default({}),
    /** Picture (an image asset of the brand) by field key; a missing one keeps the template's. */
    images: FieldImages.default({}),
    fill: TemplateFillMode.default("manual"),
    /** Shrink texts that do not fit (fields with `autoFit`); false: leave them to the checks. */
    autoFit: z.boolean().default(true),
  })
  .meta({ id: "TemplateFill" });
export type TemplateFill = z.infer<typeof TemplateFill>;

const UseTitle = z.string().trim().min(1).max(200);
const UsePlatforms = z
  .array(Platform)
  .max(3)
  .refine((list) => new Set(list).size === list.length, "platforms must be unique");

/** `POST /api/templates/{id}/use`: a new draft post from the template, filled by a job. */
export const TemplateUse = z
  .object({
    /** Default: the template's name. */
    title: UseTitle.optional(),
    /** What the post is about (the AI fill writes from it). */
    brief: z.string().max(20_000).optional(),
    values: FieldValues.optional(),
    images: FieldImages.optional(),
    /** Default: `ai` with a brief, else `manual`. */
    fill: TemplateFillMode.optional(),
    autoFit: z.boolean().optional(),
    /** Default: the source post's platforms. */
    targetPlatforms: UsePlatforms.optional(),
    instructions: z.string().max(4_000).optional(),
    /** A chat that asked for it (the AI fill resolves `@aliases` there). */
    conversationId: EntityId.optional(),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
    /** What an AI picture of an empty image slot shows (default: the title and brief). */
    imageBrief: z.string().max(4_000).optional(),
    /**
     * Fill the template's empty image slots (unlocked slot fields without a picture in `images`)
     * through the product-image line, after the owner consented to the paid generation (the
     * client's own consent prompt; the chat's card). Absent = no paid picture; the slots stay
     * empty. Its `productIds` also give the AI fill the products' facts.
     */
    slotImage: SlotImageRequest.optional(),
  })
  .meta({ id: "TemplateUse" });
export type TemplateUse = z.input<typeof TemplateUse>;

export const TemplateUseResult = z
  .object({ content: Content, job: Job })
  .meta({ id: "TemplateUseResult" });
export type TemplateUseResult = z.infer<typeof TemplateUseResult>;

/** The fill mode `TemplateUse` means when it does not say. */
export function templateFillMode(input: {
  fill?: TemplateFillMode | undefined;
  brief?: string | undefined;
}): TemplateFillMode {
  if (input.fill) return input.fill;
  return input.brief?.trim() ? "ai" : "manual";
}

/** Fields a fill writes (unlocked ones of the kind). */
export function fillableFields(
  template: Pick<ContentTemplate, "fields">,
  kind?: TemplateFieldKind,
): TemplateField[] {
  return template.fields.filter((f) => !f.locked && (kind === undefined || f.kind === kind));
}

/** Values and images naming no unlocked field of the template (a refusal lists them). */
export function unknownFieldKeys(
  template: Pick<ContentTemplate, "fields">,
  input: { values?: Record<string, string>; images?: Record<string, string> },
): string[] {
  const text = new Set(fillableFields(template, "text").map((f) => f.key));
  const image = new Set(fillableFields(template, "image").map((f) => f.key));
  return [
    ...Object.keys(input.values ?? {}).filter((k) => !text.has(k)),
    ...Object.keys(input.images ?? {}).filter((k) => !image.has(k)),
  ];
}

// --- repurposing (N10) ---------------------------------------------------------------------

export const RepurposeTarget = z.enum(["story", "reel"]).meta({ id: "RepurposeTarget" });
export type RepurposeTarget = z.infer<typeof RepurposeTarget>;

/** The `repurpose` part of a `content.generate` payload. */
export const RepurposeSpec = z
  .object({
    sourceContentId: EntityId,
    sourceVersion: z.number().int().min(1),
    target: RepurposeTarget,
  })
  .meta({ id: "RepurposeSpec" });
export type RepurposeSpec = z.infer<typeof RepurposeSpec>;

/** `POST /api/contents/{id}/repurpose`. */
export const ContentRepurpose = z
  .object({
    target: RepurposeTarget,
    /** Default: the source's title with " · Story" / " · Reels". */
    title: UseTitle.optional(),
    instructions: z.string().max(4_000).optional(),
    /** Default: the source's platforms. */
    targetPlatforms: UsePlatforms.optional(),
    conversationId: EntityId.optional(),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
  })
  .meta({ id: "ContentRepurpose" });
export type ContentRepurpose = z.input<typeof ContentRepurpose>;

export const ContentRepurposeResult = z
  .object({ content: Content, job: Job })
  .meta({ id: "ContentRepurposeResult" });
export type ContentRepurposeResult = z.infer<typeof ContentRepurposeResult>;

/** Most posts one bulk conversion takes. */
export const MAX_REPURPOSE_CONTENTS = 30;

/** `POST /api/contents/repurpose`: the same conversion for many posts (Postlar's "Dönüştür"). */
export const ContentRepurposeMany = z
  .object({
    contentIds: z
      .array(EntityId)
      .min(1)
      .max(MAX_REPURPOSE_CONTENTS)
      .refine((ids) => new Set(ids).size === ids.length, "contentIds must be unique"),
    target: RepurposeTarget,
    instructions: z.string().max(4_000).optional(),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
  })
  .meta({ id: "ContentRepurposeMany" });
export type ContentRepurposeMany = z.input<typeof ContentRepurposeMany>;

/**
 * Why a post was not converted: `not_found`, `deleted` (in the trash), `no_version` (no design
 * yet), `unsupported` (a Reels, or a story to a story).
 */
export const RepurposeSkipReason = z
  .enum(["not_found", "deleted", "no_version", "unsupported"])
  .meta({ id: "RepurposeSkipReason" });
export type RepurposeSkipReason = z.infer<typeof RepurposeSkipReason>;

export const ContentRepurposeManyResult = z
  .object({
    created: z.array(z.object({ sourceContentId: EntityId, content: Content, job: Job })),
    skipped: z.array(
      z.object({
        contentId: EntityId,
        reason: RepurposeSkipReason,
        /** Turkish, for the user. */
        message: z.string(),
      }),
    ),
  })
  .meta({ id: "ContentRepurposeManyResult" });
export type ContentRepurposeManyResult = z.infer<typeof ContentRepurposeManyResult>;

/** Why `content` cannot become a `target` (Turkish), or null. Shared by the API and the apps. */
export function repurposeBlocker(
  content: Pick<Content, "type" | "currentVersion"> & { deletedAt?: string | null | undefined },
  target: RepurposeTarget,
): { reason: RepurposeSkipReason; message: string } | null {
  if (content.deletedAt) return { reason: "deleted", message: "Post silinmiş; önce geri al." };
  if (content.type === "reel")
    return { reason: "unsupported", message: "Reels başka bir türe dönüştürülemez." };
  if (target === "story" && content.type === "story")
    return { reason: "unsupported", message: "Bu post zaten bir story." };
  if (!content.currentVersion)
    return { reason: "no_version", message: "Postun henüz tasarımı yok; önce üret." };
  return null;
}

/** "Story" / "Reels" for titles and messages. */
export const REPURPOSE_LABEL = { story: "Story", reel: "Reels" } as const satisfies Record<
  RepurposeTarget,
  string
>;
