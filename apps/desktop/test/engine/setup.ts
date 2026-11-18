// Wecra's engine (the vendored, committed Wasm build) headless in the tests, as Wecra's own
// engine tests run it: the web build's glue gets `window` / `document` (jsdom) and the Wasm bytes.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll } from "vitest";
import { WECRA_MISSING } from "../../src/renderer/features/post-editor/wecra/vendored.ts";

const wasm = resolve(
  import.meta.dirname,
  "../../src/renderer/vendor/wecra-editor/src/renderer/src/engine/wasm/engine.wasm",
);
if (!existsSync(wasm)) throw new Error(WECRA_MISSING);

beforeAll(async () => {
  const { loadEngine } = await import("@/engine/loadEngine");
  const bytes = readFileSync(wasm);
  await loadEngine({
    wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    printErr: () => {},
  });
});
