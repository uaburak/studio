/**
 * Design contract v1 as data. The Markdown text (DESIGN_CONTRACT.v1.md) explains
 * these values; the parser, patch operations, sanitiser and linter read them from here.
 */

/** Layer types (`data-type`). */
export const LAYER_TYPES = ["text", "image", "shape", "logo", "slot", "group"] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

/**
 * Layer roles (`data-role`). v1 adds `background` (full-bleed colour fields; the void and
 * clear-space checks ignore them) and `sign-off` (the logo + web address group).
 */
export const LAYER_ROLES = [
  "eyebrow",
  "headline",
  "subhead",
  "body",
  "cta",
  "caption",
  "legal",
  "badge",
  "decoration",
  "counter",
  "background",
  "sign-off",
] as const;
export type LayerRole = (typeof LAYER_ROLES)[number];

export const SLOT_STATES = ["empty", "filled"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

export const IMAGE_FITS = ["cover", "contain", "fill", "none", "scale-down"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

/** `data-layer` ids: kebab-case, starts with a letter, at most 48 characters. */
export const LAYER_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
export const LAYER_ID_MAX_LENGTH = 48;

/** `data-slot-ratio`: `W:H` with positive integers. */
export const SLOT_RATIO_PATTERN = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/;

/** Inline markup allowed inside a text layer. */
export const TEXT_INLINE_TAGS = [
  "span",
  "br",
  "wbr",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sup",
  "sub",
  "mark",
] as const;

/** Elements that must never appear in a static design (contract §6). */
export const FORBIDDEN_ELEMENTS = [
  "script",
  "noscript",
  "iframe",
  "object",
  "embed",
  "applet",
  "video",
  "audio",
  "canvas",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "base",
  "frame",
  "frameset",
  "template",
  "portal",
  "math",
] as const;

/** Virtual origins served by the renderer and the editor (contract §1, §6). */
export const VIRTUAL_PREFIXES = ["/brand/", "/media/"] as const;
export type VirtualPrefix = (typeof VIRTUAL_PREFIXES)[number];

/** The one stylesheet a design links. */
export const BRAND_CSS_PATH = "/brand/brand.css";

/** Logos live here (contract §2, logo layers). */
export const LOGO_PREFIX = "/brand/logos/";

/** Contract-wide numeric thresholds. The linter uses these as defaults. */
export const CONTRACT_LIMITS = {
  /** Text and logos stay this far from every edge (px at 1080 width). */
  safeArea: 64,
  /** Absolute minimum font size (px). */
  minFontSize: 24,
  /** Running text should be at least this size (px). */
  bodyFontSize: 28,
  /** `data-role="legal"` may go down to this size (px). */
  legalMinFontSize: 20,
  /** Warn above this many layers. */
  maxLayers: 45,
  /** Slot box ratio must match `data-slot-ratio` within this relative tolerance. */
  slotRatioTolerance: 0.01,
  /** Contrast thresholds (WCAG 2.x). */
  contrastNormal: 4.5,
  contrastLarge: 3,
  /** "Large" text: at least this size, or `largeBoldFontSize` when bold (>= 700). */
  largeFontSize: 48,
  largeBoldFontSize: 36,
} as const;

/** Standard artboards (PLAN.md §5). Platform presets live in `@studio/design-kit/presets`. */
export const ARTBOARD_SIZES = {
  portrait: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
} as const;

/** Largest artboard edge the kit accepts (same as `MAX_ARTBOARD_PX` in @studio/contract). */
export const MAX_ARTBOARD_PX = 4096;

/** Layer attributes the contract defines. */
export const LAYER_ATTRIBUTES = {
  id: "data-layer",
  type: "data-type",
  role: "data-role",
  hidden: "data-hidden",
  allowOverlap: "data-allow-overlap",
  slotRatio: "data-slot-ratio",
  slotState: "data-slot-state",
  slotLabel: "data-slot-label",
  slotFit: "data-slot-fit",
  slotImage: "data-slot-image",
  artboard: "data-artboard",
} as const;
