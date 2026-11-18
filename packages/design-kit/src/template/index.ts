// Brand templates (N9) and repurposing (N10), isomorphic: a post's slides as a layout with
// fillable fields, filling them (HTML patches, Wecra operations, auto-fit) and reading what a
// post says for a story / Reels made from it.

export {
  canvasTextMetrics,
  looksLikeAddress,
  mediaAssetId,
  type TemplateExtraction,
  type TemplateFieldDraft,
  type TemplateSlideInput,
  templateFields,
} from "./fields.ts";
export {
  type CanvasFillOperation,
  canvasFillOperations,
  canvasFitCorrections,
  type FillField,
  type FillValues,
  fieldFloor,
  htmlFillPatches,
  planFitSizes,
  type SlidePatch,
} from "./fill.ts";
export {
  AUTO_FIT_MIN_SCALE,
  autoFitFloor,
  contractMinFontSize,
  type FitResult,
  fitsAt,
  fitTextSize,
  type TextBox,
  type TextMetrics,
  textCapacity,
  wrapLines,
} from "./fit.ts";
export {
  type PostSource,
  readPostSource,
  type SourceImage,
  type SourceSlide,
  type SourceText,
  sourceImages,
} from "./source.ts";
