// Build settings for Wecra's editor, vendored (gitignored) in src/renderer/vendor/wecra-editor by
// scripts/vendor-wecra.mjs: Wecra's own import aliases (`@/…` its renderer, `@shared/…` what it
// shares with its main process) and stand-ins for the few packages of features the post editor
// leaves out (visual search and image models: transformers.js / onnxruntime; plugins: QuickJS).
// Shared by the app (electron.vite.config.ts) and the tests (vitest.config.ts).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Alias, Plugin } from "vite";

export const WECRA_DIR = resolve(import.meta.dirname, "src/renderer/vendor/wecra-editor");
const RENDERER = resolve(WECRA_DIR, "src/renderer/src");
const SHARED = resolve(WECRA_DIR, "src/shared");

/** Whether Wecra's editor is vendored on this checkout. */
export const wecraVendored = () => existsSync(resolve(WECRA_DIR, "VERSION.json"));

/** `@/…` and `@shared/…`, as Wecra's own Vite config (Studio's code uses `@renderer/…`). */
export const wecraAliases: Alias[] = [
  { find: /^@shared\//, replacement: `${SHARED}/` },
  { find: /^@\//, replacement: `${RENDERER}/` },
];

const UNAVAILABLE = `const unavailable = () => { throw new Error("Studio'nun post düzenleyicisinde yok."); };`;

/** Package → stand-in module (named exports the vendored code imports). */
const STUBS: [RegExp, string][] = [
  [
    /^@huggingface\/transformers$/,
    `${UNAVAILABLE}
export const AutoProcessor = { from_pretrained: unavailable };
export const AutoTokenizer = { from_pretrained: unavailable };
export const CLIPTextModelWithProjection = { from_pretrained: unavailable };
export const CLIPVisionModelWithProjection = { from_pretrained: unavailable };
export const RawImage = { read: unavailable, fromBlob: unavailable };
export const env = {};
export const pipeline = unavailable;
export default {};`,
  ],
  [/^onnxruntime-web\/.*\?url$/, `export default "";`],
  [
    /^onnxruntime-web(\/.*)?$/,
    `${UNAVAILABLE}
export const env = { wasm: {}, webgpu: {} };
export const InferenceSession = { create: unavailable };
export const Tensor = unavailable;
export default { env, InferenceSession, Tensor };`,
  ],
  [/^@jitl\/quickjs-wasmfile-release-asyncify\/.*\?url$/, `export default "";`],
  [/^@jitl\/quickjs-wasmfile-release-asyncify$/, `export default {};`],
  [
    /^quickjs-emscripten-core$/,
    `${UNAVAILABLE}
export const newQuickJSAsyncWASMModuleFromVariant = unavailable;
export const newVariant = unavailable;
export default {};`,
  ],
];

/**
 * Wecra's global stylesheet styles a whole page (body, every element's transitions …): Studio
 * loads its own, scoped to the editor's places, in its place.
 */
const WECRA_GLOBAL_CSS =
  /[\\/]vendor[\\/]wecra-editor[\\/]src[\\/]renderer[\\/]src[\\/]ds[\\/]global\.css$/;
const STUDIO_WECRA_CSS = resolve(
  import.meta.dirname,
  "src/renderer/features/post-editor/wecra/wecra.css",
);

/** The stand-ins (resolved before node_modules, for the app and its workers). */
export function wecraStubs(): Plugin {
  const PREFIX = "\0wecra-stub:";
  return {
    name: "studio-wecra-stubs",
    enforce: "pre",
    resolveId(source) {
      if (WECRA_GLOBAL_CSS.test(source) || source === "@/ds/global.css") return STUDIO_WECRA_CSS;
      const i = STUBS.findIndex(([re]) => re.test(source));
      return i >= 0 ? `${PREFIX}${i}` : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      return STUBS[Number(id.slice(PREFIX.length))]?.[1] ?? null;
    },
  };
}
