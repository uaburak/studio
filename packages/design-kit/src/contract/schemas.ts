import { z } from "zod";
import {
  IMAGE_FITS,
  LAYER_ID_PATTERN,
  LAYER_ROLES,
  LAYER_TYPES,
  MAX_ARTBOARD_PX,
  SLOT_STATES,
} from "./constants.ts";

export const LayerTypeSchema = z.enum(LAYER_TYPES);
export const LayerRoleSchema = z.enum(LAYER_ROLES);
export const SlotStateSchema = z.enum(SLOT_STATES);
export const ImageFitSchema = z.enum(IMAGE_FITS);

export const LayerIdSchema = z
  .string()
  .regex(LAYER_ID_PATTERN, "layer ids are kebab-case: [a-z][a-z0-9-]*, at most 48 characters");

export const ArtboardSizeSchema = z.object({
  width: z.number().int().min(1).max(MAX_ARTBOARD_PX),
  height: z.number().int().min(1).max(MAX_ARTBOARD_PX),
});
export type ArtboardSize = z.infer<typeof ArtboardSizeSchema>;

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

/**
 * Editor transform of a layer. Written as the individual CSS properties
 * `translate`, `rotate` and `scale` in the layer's inline style, so moving a layer
 * inside a flex group never reflows its siblings and never clobbers a `transform`
 * the design declared in its stylesheet.
 */
export const LayerTransformSchema = z.object({
  /** px */
  translate: PointSchema.nullable(),
  /** degrees, clockwise */
  rotate: z.number().nullable(),
  /** factor per axis */
  scale: PointSchema.nullable(),
});
export type LayerTransform = z.infer<typeof LayerTransformSchema>;

const LayerBaseSchema = z.object({
  id: z.string(),
  /** Role, when `data-role` holds a known value. */
  role: LayerRoleSchema.nullable(),
  /** Raw `data-role` value (also set when it is not a known role). */
  rawRole: z.string().nullable(),
  /** Lowercase element name (`div`, `h1`, `img`, `svg`, ...). */
  tag: z.string(),
  /** Id of the nearest ancestor layer, `null` for top-level layers. */
  parent: z.string().nullable(),
  /** Ids of the layers whose nearest ancestor layer is this one, in document order. */
  children: z.array(z.string()),
  /** `data-hidden` is present: the layer is not painted (editor show/hide). */
  hidden: z.boolean(),
  /** `data-allow-overlap` is present. */
  allowOverlap: z.boolean(),
  classes: z.array(z.string()),
  /** Inline style declarations (last one wins), property names lowercase. */
  style: z.record(z.string(), z.string()),
  transform: LayerTransformSchema,
});

export const TextLayerSchema = LayerBaseSchema.extend({
  type: z.literal("text"),
  /** Plain text: entities decoded, `<br>` as `\n`, whitespace collapsed like CSS `normal`. */
  text: z.string(),
  /** Inner HTML exactly as written in the source. */
  html: z.string(),
});

export const ImageLayerSchema = LayerBaseSchema.extend({
  type: z.literal("image"),
  src: z.string().nullable(),
  alt: z.string().nullable(),
  fit: ImageFitSchema.nullable(),
  position: z.string().nullable(),
});

export const LogoLayerSchema = LayerBaseSchema.extend({
  type: z.literal("logo"),
  src: z.string().nullable(),
  alt: z.string().nullable(),
});

export const ShapeLayerSchema = LayerBaseSchema.extend({
  type: z.literal("shape"),
  /** The layer is an inline `<svg>`. */
  svg: z.boolean(),
});

export const SlotImageSchema = z.object({
  src: z.string().nullable(),
  alt: z.string().nullable(),
  fit: ImageFitSchema.nullable(),
  position: z.string().nullable(),
});

export const SlotLayerSchema = LayerBaseSchema.extend({
  type: z.literal("slot"),
  /** Parsed `data-slot-ratio`, `null` when missing or malformed. */
  ratio: z.object({ w: z.number().int(), h: z.number().int() }).nullable(),
  state: SlotStateSchema.nullable(),
  label: z.string().nullable(),
  /** `data-slot-fit` (default fit for the image that fills the slot). */
  fit: ImageFitSchema.nullable(),
  /** The `<img data-slot-image>` when the slot is filled. */
  image: SlotImageSchema.nullable(),
});

export const GroupLayerSchema = LayerBaseSchema.extend({
  type: z.literal("group"),
});

export const LayerSchema = z.discriminatedUnion("type", [
  TextLayerSchema,
  ImageLayerSchema,
  LogoLayerSchema,
  ShapeLayerSchema,
  SlotLayerSchema,
  GroupLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;
export type TextLayer = z.infer<typeof TextLayerSchema>;
export type ImageLayer = z.infer<typeof ImageLayerSchema>;
export type LogoLayer = z.infer<typeof LogoLayerSchema>;
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;
export type SlotLayer = z.infer<typeof SlotLayerSchema>;
export type GroupLayer = z.infer<typeof GroupLayerSchema>;

export const StructureIssueSchema = z.object({
  /** Lint rule id this issue maps to (same ids as the linter). */
  rule: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  layer: z.string().nullable(),
  message: z.string(),
});
export type StructureIssue = z.infer<typeof StructureIssueSchema>;

/** The typed layer tree of one slide. Produced by `parseSlide()`. */
export const SlideModelSchema = z.object({
  /** `<meta name="studio:contract">`, e.g. `v1`. */
  contract: z.string().nullable(),
  /** `<html lang>`. */
  lang: z.string().nullable(),
  /** `<meta name="studio:format">`, e.g. `1080x1350`. */
  format: ArtboardSizeSchema.nullable(),
  /** Size from the artboard's inline `width`/`height` (px). */
  artboard: ArtboardSizeSchema.nullable(),
  /** Every layer, in document order. */
  layers: z.array(LayerSchema),
  /** Ids of the top-level layers (direct layer children of the artboard), in document order. */
  roots: z.array(z.string()),
  /** Structural problems found while parsing (also reported by the linter). */
  issues: z.array(StructureIssueSchema),
});
export type SlideModel = z.infer<typeof SlideModelSchema>;
