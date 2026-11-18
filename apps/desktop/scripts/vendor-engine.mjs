#!/usr/bin/env node
// Vendors Wecra's canvas engine (Burak's DesignerV2 repo) into the desktop renderer:
//
//   node apps/desktop/scripts/vendor-engine.mjs [--repo <DesignerV2>] [--ref <git ref>] [--check]
//
// Everything is read from DesignerV2's git history (`git show <ref>:<path>`), never from its
// working tree and never written back: the committed Emscripten build (engine.mjs + engine.wasm,
// built by DesignerV2's `npm run engine:build`), the hand-written ABI wrapper and its JSON codec,
// the input helpers, the cursor pictures and the bundled Inter that the engine's overlays use.
// A blank engine document (DOCUMENT + one page, encoded with DesignerV2's generated kiwi codec,
// because `engine_load` takes kiwi only) is written next to them. VERSION.json records the commit
// and the SHA-256 of every file; `--check` verifies the vendored copy against it.
//
// To move to a newer engine: commit the engine build in DesignerV2, then run this script with
// `--ref <commit>` (default HEAD) and run the desktop tests (test/engine/*).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const outDir = join(desktop, "src/renderer/vendor/wecra-engine");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const repo = resolve(
  arg("--repo", process.env.WECRA_REPO ?? resolve(desktop, "../../../DesignerV2")),
);
const ref = arg("--ref", "HEAD");
const check = process.argv.includes("--check");

const ENGINE = "src/renderer/src/engine";
/** [source path in DesignerV2, path under vendor/wecra-engine] */
const FILES = [
  [`${ENGINE}/wasm/engine.mjs`, "wasm/engine.mjs"],
  [`${ENGINE}/wasm/engine.wasm`, "wasm/engine.wasm"],
  [`${ENGINE}/wasm/engine.d.mts`, "wasm/engine.d.mts"],
  [`${ENGINE}/EngineExports.ts`, "EngineExports.ts"],
  [`${ENGINE}/abi.ts`, "abi.ts"],
  [`${ENGINE}/codec.ts`, "codec.ts"],
  [`${ENGINE}/keyCodes.ts`, "keyCodes.ts"],
  [`${ENGINE}/pointerInput.ts`, "pointerInput.ts"],
  [`${ENGINE}/contextLoss.ts`, "contextLoss.ts"],
  [`${ENGINE}/cursors.ts`, "cursors.ts"],
  [`${ENGINE}/cursorArt/figmaCursors.generated.ts`, "cursorArt/figmaCursors.generated.ts"],
  [`${ENGINE}/fonts/Inter-3.19.ttf`, "fonts/Inter-3.19.ttf"],
  [`${ENGINE}/fonts/Inter-3.19-LICENSE.txt`, "fonts/Inter-3.19-LICENSE.txt"],
];

/** Imports of DesignerV2-only modules, replaced by local stand-ins (types only). */
const REWRITES = {
  "codec.ts": [
    [
      'import type { DrawToolSampled } from "../../../shared/draw/types";',
      "type DrawToolSampled = Record<string, unknown>; // Wecra's Draw tool type (not used here)",
    ],
  ],
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function show(path) {
  return git(["show", `${ref}:${path}`], "buffer");
}

if (check) {
  const version = JSON.parse(readFileSync(join(outDir, "VERSION.json"), "utf8"));
  let bad = 0;
  for (const [file, hash] of Object.entries(version.files)) {
    const path = join(outDir, file);
    const actual = existsSync(path) ? sha256(readFileSync(path)) : "missing";
    if (actual !== hash) {
      console.error(`vendor-engine: ${file} differs from VERSION.json (${actual.slice(0, 12)})`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`vendor-engine: ${Object.keys(version.files).length} files match ${version.commit}`);
  process.exit(0);
}

if (!existsSync(join(repo, ".git"))) {
  console.error(`vendor-engine: no DesignerV2 checkout at ${repo} (pass --repo)`);
  process.exit(1);
}

const commit = git(["rev-parse", `${ref}^{commit}`]).trim();
const commitDate = git(["show", "-s", "--format=%cI", commit]).trim();
const engineCommit = git([
  "log",
  "-1",
  "--format=%H",
  commit,
  "--",
  "engine",
  "schema",
  ENGINE,
]).trim();
const emsdk = show("engine/EMSDK_VERSION").toString("utf8").trim();

const files = {};
mkdirSync(join(outDir, "wasm"), { recursive: true });
mkdirSync(join(outDir, "fonts"), { recursive: true });
mkdirSync(join(outDir, "cursorArt"), { recursive: true });
for (const [from, to] of FILES) {
  let bytes = show(from);
  if (to.endsWith(".ts") && !to.endsWith(".d.mts")) {
    let text = bytes.toString("utf8");
    for (const [a, b] of REWRITES[to] ?? []) {
      if (!text.includes(a)) throw new Error(`vendor-engine: ${to} no longer has: ${a}`);
      text = text.replace(a, b);
    }
    // Wecra's tsconfig is not Studio's (noUncheckedIndexedAccess …): the copies are not
    // re-checked here; their exported types still are.
    text = `// @ts-nocheck\n// Vendored from Wecra (DesignerV2) ${commit.slice(0, 10)}:${from}.\n// Do not edit: run apps/desktop/scripts/vendor-engine.mjs.\n${text}`;
    bytes = Buffer.from(text, "utf8");
  }
  writeFileSync(join(outDir, to), bytes);
  files[to] = sha256(bytes);
}

// The blank document, encoded with DesignerV2's generated kiwi codec of the same commit.
const tmp = mkdtempSync(join(tmpdir(), "wecra-codec-"));
try {
  const kiwi = pathToFileURL(join(repo, "node_modules/kiwi-schema/kiwi-esm.js")).href;
  const generated = show("src/shared/schema/document.generated.ts")
    .toString("utf8")
    .replace('from "kiwi-schema"', `from ${JSON.stringify(kiwi)}`);
  writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
  writeFileSync(join(tmp, "document.generated.ts"), generated);
  const { codec } = await import(pathToFileURL(join(tmp, "document.generated.ts")).href);
  const guid = (localID) => ({ sessionID: 0, localID });
  const bytes = codec.encodeMessage({
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [
      { guid: guid(0), phase: "CREATED", type: "DOCUMENT", name: "Document" },
      {
        guid: guid(1),
        phase: "CREATED",
        type: "CANVAS",
        name: "Post",
        parentIndex: { guid: guid(0), position: "!" },
        // Black: the editor turns the canvas transparent from it (engine/alpha-pass.ts).
        backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
        backgroundEnabled: true,
      },
      {
        guid: guid(2),
        phase: "CREATED",
        type: "CANVAS",
        name: "Internal Only Canvas",
        parentIndex: { guid: guid(0), position: "~" },
        internalOnly: true,
        visible: false,
      },
    ],
    blobs: [],
  });
  const text = `// Generated by apps/desktop/scripts/vendor-engine.mjs from Wecra ${commit.slice(0, 10)}. Do not edit.
// A blank engine document as a kiwi Message (engine_load takes kiwi only): DOCUMENT 0:0, the page
// 0:1 (black background) and the internal canvas 0:2. Everything else arrives as JSON changes.
export const BLANK_DOCUMENT_BASE64 = ${JSON.stringify(Buffer.from(bytes).toString("base64"))};
export const PAGE_GUID = "0:1";
`;
  writeFileSync(join(outDir, "blank-document.ts"), text);
  files["blank-document.ts"] = sha256(Buffer.from(text, "utf8"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const abi = /ABI_VERSION = (\d+)/.exec(readFileSync(join(outDir, "abi.ts"), "utf8"))?.[1];
const version = {
  source: "Wecra (DesignerV2)",
  repo: "DesignerV2",
  ref,
  commit,
  commitDate,
  engineCommit,
  abiVersion: Number(abi),
  emsdk,
  build: "wasm-release (WebGL2 + WebGPU, -O3 -flto), committed artifact",
  vendoredAt: new Date().toISOString(),
  files,
};
writeFileSync(join(outDir, "VERSION.json"), `${JSON.stringify(version, null, 2)}\n`);
console.log(
  `vendor-engine: ${Object.keys(files).length} files from ${commit.slice(0, 10)} (${commitDate}) → ${outDir}`,
);
