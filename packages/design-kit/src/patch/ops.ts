/**
 * Patch operations: typed, serialisable edits of one slide document. Version history
 * stores them as JSON (`PatchLog`); the editor keeps `{ op, inverse }` pairs for undo/redo.
 */
import { z } from "zod";
import { IMAGE_FITS, LAYER_ROLES, SLOT_RATIO_PATTERN } from "../contract/constants.ts";
import { LayerIdSchema } from "../contract/schemas.ts";
import { PATCH_SCHEMA } from "../version.ts";

const Ref = z.string().min(1).max(64);
const Finite = z.number().finite();
const Px = Finite.min(-10000).max(10000);
const PositivePx = Finite.min(0).max(10000);
const TokenName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, "token names are kebab-case");
const Html = z.string().max(200_000);
const ClassName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z_][A-Za-z0-9_-]*)*$/, "space-separated class names");

/** A colour: a brand token (`--color-<token>`) or a literal (`#RRGGBB`, `rgb()`, `hsl()`). */
export const ColorValue = z.union([
  z.object({ token: TokenName }).strict(),
  z.object({ literal: z.string().max(80) }).strict(),
]);
export type ColorValue = z.infer<typeof ColorValue>;

const PositionComponent = z.union([
  z.enum(["left", "center", "right", "top", "bottom"]),
  z.string().regex(/^-?\d+(?:\.\d+)?(?:px|%)$/),
]);
export const ImagePosition = z.object({ x: PositionComponent, y: PositionComponent }).strict();

/** Inline style values for new layers: allow-listed property -> value. */
const StyleMap = z.record(z.string().max(40), z.string().max(200));

export const SetTextOp = z
  .object({
    op: z.literal("setText"),
    layer: Ref,
    /** Plain text; `\n` becomes `<br>`. */
    text: z.string().max(20_000).optional(),
    /** Inline HTML (span, br, strong, em, b, i, u, s, small, sup, sub, mark, wbr). */
    html: Html.optional(),
  })
  .strict()
  .refine(
    (o) => (o.text === undefined) !== (o.html === undefined),
    "give exactly one of text or html",
  );

export const SetStyleOp = z
  .object({
    op: z.literal("setStyle"),
    layer: Ref,
    /** Allow-listed property -> value, `null` removes the property. Applied in key order. */
    set: z.record(z.string().max(40), z.string().max(200).nullable()),
  })
  .strict();

export const TransformOp = z
  .object({
    op: z.literal("transform"),
    layer: Ref,
    /** px offset written as `translate`; `null` removes it. */
    translate: z.object({ x: Px, y: Px }).strict().nullable().optional(),
    /** degrees written as `rotate`; `null` removes it. */
    rotate: Finite.min(-360).max(360).nullable().optional(),
    /** factor (or per axis) written as `scale`; `null` removes it. */
    scale: z
      .union([
        Finite.min(-20).max(20),
        z.object({ x: Finite.min(-20).max(20), y: Finite.min(-20).max(20) }).strict(),
      ])
      .nullable()
      .optional(),
  })
  .strict();

export const ResizeOp = z
  .object({
    op: z.literal("resize"),
    layer: Ref,
    width: PositivePx.nullable().optional(),
    height: PositivePx.nullable().optional(),
  })
  .strict();

export const SetColorOp = z
  .object({
    op: z.literal("setColor"),
    layer: Ref,
    property: z.enum(["color", "background-color", "border-color"]).default("color"),
    value: ColorValue.nullable(),
  })
  .strict();

export const SetTypographyOp = z
  .object({
    op: z.literal("setTypography"),
    layer: Ref,
    /** Font role token: `display` -> `var(--font-display)`. */
    fontFamily: TokenName.nullable().optional(),
    /** px */
    fontSize: Finite.min(1).max(1000).nullable().optional(),
    fontWeight: z.number().int().min(1).max(1000).nullable().optional(),
    /** Unitless multiplier. */
    lineHeight: Finite.min(0.5).max(4).nullable().optional(),
    /** em */
    letterSpacing: Finite.min(-1).max(1).nullable().optional(),
    textAlign: z.enum(["left", "right", "center", "justify", "start", "end"]).nullable().optional(),
    fontStyle: z.enum(["normal", "italic"]).nullable().optional(),
    textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).nullable().optional(),
  })
  .strict();

export const ReplaceImageOp = z
  .object({
    op: z.literal("replaceImage"),
    layer: Ref,
    src: z.string().max(1024),
    alt: z.string().max(1000).optional(),
  })
  .strict();

export const SetImageFitOp = z
  .object({
    op: z.literal("setImageFit"),
    layer: Ref,
    fit: z.enum(IMAGE_FITS).nullable().optional(),
    position: ImagePosition.nullable().optional(),
  })
  .strict();

export const FillSlotOp = z
  .object({
    op: z.literal("fillSlot"),
    layer: Ref,
    src: z.string().max(1024),
    alt: z.string().max(1000).optional(),
    fit: z.enum(IMAGE_FITS).optional(),
    position: ImagePosition.optional(),
  })
  .strict();

export const ClearSlotOp = z.object({ op: z.literal("clearSlot"), layer: Ref }).strict();

export const MoveLayerOp = z
  .object({
    op: z.literal("moveLayer"),
    layer: Ref,
    /** Target position among the container's direct layer children (0 = first = bottom of the stack). */
    index: z.number().int().min(0).max(10_000),
    /** Exact placement inside the gap before the target (characters); set by inverses. */
    gapOffset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const SetVisibilityOp = z
  .object({ op: z.literal("setVisibility"), layer: Ref, hidden: z.boolean() })
  .strict();

export const DuplicateLayerOp = z
  .object({
    op: z.literal("duplicateLayer"),
    layer: Ref,
    /** Id of the copy; default `<id>-copy` (made unique). Descendant ids get the same suffix. */
    newId: LayerIdSchema.optional(),
    /** Move the copy by this many px (written as `translate`). */
    offset: z.object({ x: Px, y: Px }).strict().optional(),
  })
  .strict();

export const DeleteLayerOp = z.object({ op: z.literal("deleteLayer"), layer: Ref }).strict();

const NewLayerBase = {
  id: LayerIdSchema,
  role: z.enum(LAYER_ROLES).optional(),
  className: ClassName.optional(),
  style: StyleMap.optional(),
};

export const NewLayerSpec = z.discriminatedUnion("type", [
  z
    .object({
      ...NewLayerBase,
      type: z.literal("text"),
      tag: z.enum(["p", "h1", "h2", "h3", "h4", "h5", "h6", "div"]).optional(),
      text: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      ...NewLayerBase,
      type: z.literal("image"),
      src: z.string().max(1024),
      alt: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      ...NewLayerBase,
      type: z.literal("logo"),
      src: z.string().max(1024),
      alt: z.string().max(1000).optional(),
    })
    .strict(),
  z.object({ ...NewLayerBase, type: z.literal("shape") }).strict(),
  z
    .object({
      ...NewLayerBase,
      type: z.literal("slot"),
      ratio: z.string().regex(SLOT_RATIO_PATTERN, "W:H"),
      label: z.string().min(1).max(80),
      fit: z.enum(IMAGE_FITS).optional(),
    })
    .strict(),
  z.object({ ...NewLayerBase, type: z.literal("group") }).strict(),
]);
export type NewLayerSpec = z.infer<typeof NewLayerSpec>;

export const AddLayerOp = z
  .object({
    op: z.literal("addLayer"),
    /** Group id, or `null` for the artboard. */
    parent: Ref.nullable(),
    /** Position among the container's direct layer children; default: last (on top). */
    index: z.number().int().min(0).max(10_000).optional(),
    layer: NewLayerSpec,
  })
  .strict();

export const InsertLayerOp = z
  .object({
    op: z.literal("insertLayer"),
    parent: Ref.nullable(),
    index: z.number().int().min(0).max(10_000),
    /** One element carrying a new, unique `data-layer`. Must be clean (sanitiser) markup. */
    html: Html,
    /** Whitespace written before the element. */
    leading: z.string().max(400).regex(/^\s*$/).optional(),
    gapOffset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const ReplaceLayerOp = z
  .object({
    op: z.literal("replaceLayer"),
    layer: Ref,
    /** One element with the same `data-layer` id; replaces the layer's outer HTML exactly. */
    html: Html,
  })
  .strict();

export const PatchOp = z.union([
  SetTextOp,
  SetStyleOp,
  TransformOp,
  ResizeOp,
  SetColorOp,
  SetTypographyOp,
  ReplaceImageOp,
  SetImageFitOp,
  FillSlotOp,
  ClearSlotOp,
  MoveLayerOp,
  SetVisibilityOp,
  DuplicateLayerOp,
  DeleteLayerOp,
  AddLayerOp,
  InsertLayerOp,
  ReplaceLayerOp,
]);
export type PatchOp = z.infer<typeof PatchOp>;
export type PatchOpInput = z.input<typeof PatchOp>;
export type PatchOpName = PatchOp["op"];

export const PATCH_OP_NAMES = [
  "setText",
  "setStyle",
  "transform",
  "resize",
  "setColor",
  "setTypography",
  "replaceImage",
  "setImageFit",
  "fillSlot",
  "clearSlot",
  "moveLayer",
  "setVisibility",
  "duplicateLayer",
  "deleteLayer",
  "addLayer",
  "insertLayer",
  "replaceLayer",
] as const satisfies readonly PatchOpName[];

/** One applied operation with its inverse, as stored in history. */
export const PatchEntry = z.object({ op: PatchOp, inverse: PatchOp });
export type PatchEntry = z.infer<typeof PatchEntry>;

/**
 * An operation log for version history: ordered entries plus the SHA-256 (hex) of the
 * slide HTML before and after (see `computeContentHash` in @studio/contract for versions).
 */
export const PatchLog = z.object({
  schema: z.literal(PATCH_SCHEMA),
  slide: z.number().int().min(0),
  entries: z.array(PatchEntry),
  beforeSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  afterSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type PatchLog = z.infer<typeof PatchLog>;
