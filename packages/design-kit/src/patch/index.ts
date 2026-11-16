// Typed, invertible, serialisable edits of a slide document (isomorphic).
export {
  applyPatch,
  applyPatches,
  layerSpecHtml,
  type PatchContext,
  PatchError,
  type PatchErrorCode,
  type PatchResult,
  revertPatches,
} from "./apply.ts";
export * from "./ops.ts";
export { isAllowedStyle, isColorLiteral, isColorValue, STYLE_PROPERTIES } from "./style.ts";
