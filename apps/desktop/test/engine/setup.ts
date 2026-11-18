// The engine's web build in Node: its glue looks up `window` and `document` when it starts
// (its DOM helpers) and gets the Wasm bytes passed in; headless engines need nothing else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";
import {
  loadEngineModule,
  setInterSource,
} from "../../src/renderer/features/post-editor/engine/studio-engine.ts";

const vendor = new URL("../../src/renderer/vendor/wecra-engine/", import.meta.url);

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  setInterSource(
    async () =>
      new Uint8Array(readFileSync(fileURLToPath(new URL("fonts/Inter-3.19.ttf", vendor)))),
  );
  const bytes = readFileSync(fileURLToPath(new URL("wasm/engine.wasm", vendor)));
  await loadEngineModule({
    wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    printErr: () => {},
  });
});
