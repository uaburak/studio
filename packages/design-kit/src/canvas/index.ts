// Canvas slides (saved from Wecra's editor): their facts, their slide HTML and their checks
// (isomorphic: the desktop builds the HTML, the worker checks it).
export {
  CANVAS_FACTS_VERSION,
  CANVAS_NODE_TYPES,
  CanvasFacts,
  CanvasLine,
  CanvasMark,
  CanvasNode,
  CanvasPaint,
  CanvasRect,
  CanvasText,
  CanvasTextRun,
  canvasFactsSize,
  fitCanvasFacts,
  parseCanvasFacts,
} from "./facts.ts";
export {
  CANVAS_META,
  type CanvasSlideHtmlOptions,
  type CanvasSlideKind,
  canvasAltText,
  canvasSlideHtml,
  readCanvas,
} from "./html.ts";
export {
  boxRatio,
  CANVAS_RENDER_LAYER,
  type CanvasImagePaint,
  type CanvasLayer,
  type CanvasLayoutBox,
  type CanvasSlot,
  canvasLayers,
  canvasLayout,
  isPainted,
  layerSlug,
  topImage,
} from "./layers.ts";
export { type CanvasLintInput, canvasTextContrast, lintCanvasSlide } from "./lint.ts";
