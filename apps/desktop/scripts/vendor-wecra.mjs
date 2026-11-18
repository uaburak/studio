#!/usr/bin/env node
// Vendors Wecra's editor (Burak's DesignerV2 repo, closed source) into the desktop renderer:
//
//   node apps/desktop/scripts/vendor-wecra.mjs [--repo <DesignerV2>] [--ref <git ref>] [--check]
//
// The post editor runs Wecra's own editor stack: the engine (the committed Emscripten build),
// the canvas, the Design and Layers panels, the commands, the text engine and the exporter. They
// are copied here verbatim from DesignerV2's **git history** (`git archive <ref>`, never its
// working tree, never written back):
//
//   src/renderer/src/**                  the renderer (editor, engine glue, design system, store)
//   src/shared/**                        what it shares with Wecra's main process (schema, codecs)
//   src/store/**, src/viewer/**          the store's browser half and the preview viewer's canvas
//                                        (the editor imports both)
//   src/main/agents/reach/webSpec.ts     Wecra's page capture → layers converter (import)
//
// tests are left out. Every `.ts` / `.tsx` file gets a `// @ts-nocheck` header (Wecra's tsconfig
// is not Studio's: the copies are not re-checked here, their types still are). A few embedding
// patches (REWRITES below) are applied as exact text replacements and fail loudly when the
// source moved. Generated next to the copy:
//
//   studio/walker.mjs     Wecra's DOM walker (shared/agents/web/walker.js) as a module that runs
//                         on any window (a slide's iframe), without eval
//   tsconfig.json         Wecra's compiler options for the copy (Vite reads them per file)
//   VERSION.json          the commit, the engine's commit and ABI, and the SHA-256 of every file
//
// THE COPY IS GITIGNORED: Studio's repository is public and Wecra is closed source. Never commit
// it (`git status --porcelain apps/desktop/src/renderer/vendor` must stay empty).
//
// `--check` verifies the vendored copy against VERSION.json. To move to a newer Wecra: commit in
// DesignerV2, run this script with `--ref <commit>` (default HEAD), then
// `pnpm --filter @studio/desktop test` and `typecheck`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
export const OUT_DIR = join(desktop, "src/renderer/vendor/wecra-editor");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const repo = resolve(
  arg("--repo", process.env.WECRA_REPO ?? resolve(desktop, "../../../DesignerV2")),
);
const ref = arg("--ref", "HEAD");
const check = process.argv.includes("--check");

/** What is copied (paths in DesignerV2). */
const ROOTS = [
  "src/renderer/src",
  "src/shared",
  "src/store",
  "src/viewer",
  "src/main/agents/reach/webSpec.ts",
];

/** Left out: tests and their fixtures, the developer tools that only run in Node. */
const SKIP = [
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.dom\.test\.[jt]sx?$/,
  /(^|\/)test-utils?\//,
];

/**
 * Embedding patches: [file, before, after]. Exact text; the script stops when `before` is gone
 * (Wecra changed there: look at the new code and update the patch). They all read
 * `globalThis.__wecraEmbed`, which Studio's post editor sets (features/post-editor/wecra/embed.ts);
 * without it Wecra behaves as in its own app.
 */
const EMBED = "(globalThis as { __wecraEmbed?: Record<string, any> }).__wecraEmbed";
/** A key or clipboard event that belongs to the page around the embedded editor (Studio's). */
const OUTSIDE = (event) => `${EMBED}?.ownsEvent?.(${event}) === false`;
const REWRITES = [
  [
    // The browser store (Wecra's dev store) without its demo files and with nothing kept in
    // Studio's localStorage: the post editor's document comes from Studio, not from the store.
    "src/renderer/src/store/index.ts",
    "    dev = createDevStore({\n",
    `    dev = createDevStore({\n      ...(${EMBED}?.devStore ?? {}),\n`,
  ],
  // The editor inside Studio's layout: Studio draws the panels (Wecra's Design panel and Layers,
  // in Studio's right panel and canvas card) and the toolbar (in Studio's dock); the theme is put
  // on the editor's own elements, not on Studio's <html>.
  [
    "src/renderer/src/editor/EditorApp.tsx",
    'useThemeRoot, type ThemeName } from "@/ds";',
    `useThemeRoot, useTheme, type ThemeName } from "@/ds";\n/** Embedded in Studio's post editor (its panels and toolbar are Studio's places). */\nconst embedded = () => !!${EMBED}?.studio;`,
  ],
  [
    "src/renderer/src/editor/EditorApp.tsx",
    "  const theme = useThemeRoot();",
    "  const theme = embedded() ? useTheme() : useThemeRoot();",
  ],
  [
    "src/renderer/src/editor/EditorApp.tsx",
    "{ed ? <LeftSide /> : <LeftPlaceholder />}",
    "{embedded() ? null : ed ? <LeftSide /> : <LeftPlaceholder />}",
  ],
  [
    "src/renderer/src/editor/EditorApp.tsx",
    "{ed ? <RightSide /> :",
    "{embedded() ? null : ed ? <RightSide /> :",
  ],
  [
    "src/renderer/src/editor/EditorApp.tsx",
    "{!hidden && <BottomToolbar />}",
    "{!hidden && !embedded() && <BottomToolbar />}",
  ],
  [
    "src/renderer/src/editor/EditorApp.tsx",
    "{!hidden && !shortcuts && <Help />}",
    "{!hidden && !shortcuts && !embedded() && <Help />}",
  ],
  // The bottom toolbar in Studio's dock: in flow, no mode switch (the post editor is Design
  // mode), no Comment group and no Actions (Studio has neither).
  [
    "src/renderer/src/editor/canvas/BottomToolbar.tsx",
    "export function BottomToolbar() {",
    "export function BottomToolbar({ embedded = false }: { embedded?: boolean } = {}) {",
  ],
  [
    "src/renderer/src/editor/canvas/BottomToolbar.tsx",
    "      <EditorToolbar\n      floating\n",
    `      <EditorToolbar\n      floating={!embedded}\n      hiddenGroups={embedded ? ["comment"] : undefined}\n      hideActions={embedded}\n`,
  ],
  [
    "src/renderer/src/editor/canvas/BottomToolbar.tsx",
    "      modes={modes}\n",
    "      modes={embedded ? [] : modes}\n",
  ],
  [
    "src/renderer/src/ds/components/EditorToolbar.tsx",
    "floating, offset, shortcuts, slot }: EditorToolbarProps) {",
    "floating, offset, shortcuts, slot, hiddenGroups = [], hideActions = false }: EditorToolbarProps & { hiddenGroups?: ToolGroupId[]; hideActions?: boolean }) {",
  ],
  [
    "src/renderer/src/ds/components/EditorToolbar.tsx",
    "{toolGroups(mode).map((g) => {",
    "{toolGroups(mode).filter((g) => !hiddenGroups.includes(g.id)).map((g) => {",
  ],
  [
    "src/renderer/src/ds/components/EditorToolbar.tsx",
    '{mode !== "dev" && <ToolButton icon="24.actions"',
    '{mode !== "dev" && !hideActions && <ToolButton icon="24.actions"',
  ],
  // Keys and the clipboard: only what happens in the editor's places (the canvas, its panels,
  // its overlays) — Studio's fields, buttons and chat keep theirs.
  [
    "src/renderer/src/editor/keyboard.ts",
    "  const onKeyDown = (e: KeyboardEvent) => {\n",
    `  const onKeyDown = (e: KeyboardEvent) => {\n    if (${OUTSIDE("e")}) return;\n`,
  ],
  [
    "src/renderer/src/editor/keyboard.ts",
    "  const onKeyUp = (e: KeyboardEvent) => {\n",
    `  const onKeyUp = (e: KeyboardEvent) => {\n    if (${OUTSIDE("e")}) return;\n`,
  ],
  [
    "src/renderer/src/editor/clipboardIO.ts",
    "  const onCopy = (e: ClipboardEvent, cut: boolean) => {\n",
    `  const onCopy = (e: ClipboardEvent, cut: boolean) => {\n    if (${OUTSIDE("e")}) return;\n`,
  ],
  [
    "src/renderer/src/editor/clipboardIO.ts",
    "  const onPaste = (e: ClipboardEvent) => {\n",
    `  const onPaste = (e: ClipboardEvent) => {\n    if (${OUTSIDE("e")}) return;\n`,
  ],
  // What a post editor has (E16, patches command-stub … design-panel). Studio keeps an
  // allowlist of Wecra's commands (features/post-editor/wecra/commands.ts) and takes the others
  // out of the registry itself —
  // no key, menu or panel button reaches them. These patches only let Wecra's own UI live with
  // a smaller registry: a panel asking for a command Studio left out gets a disabled stand-in
  // instead of an exception; the canvas menu, the zoom (view) menu, the Design panel header's
  // actions and the toolbar's tool menus go through Studio's filter; the Design panel leaves
  // out plugin relaunch buttons, canvas buttons, the page's Export and the MCP section.
  [
    // command-stub: a command Studio left out (embedded) reads as disabled, never throws.
    "src/renderer/src/editor/commands.ts",
    "  const c = COMMAND_BY_ID.get(id);\n  if (!c) throw",
    `  const c = COMMAND_BY_ID.get(id);\n  if (!c && ${EMBED}?.studio) return { id, label: id, run: () => {}, enabled: () => false };\n  if (!c) throw`,
  ],
  [
    // canvas-menu: the canvas / layer row menu through Studio's allowlist.
    "src/renderer/src/editor/menus.ts",
    "export function canvasMenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[], options: { row?: boolean } = {}): MenuEntry[] {",
    `export function canvasMenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[], options: { row?: boolean } = {}): MenuEntry[] {\n  const all = wecraCanvasMenu(ed, layers, options);\n  return ${EMBED}?.canvasMenu ? ${EMBED}.canvasMenu(all, ed) : all;\n}\nfunction wecraCanvasMenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[], options: { row?: boolean } = {}): MenuEntry[] {`,
  ],
  [
    // view-menu: the zoom menu (Studio's view menu) through Studio's filter (its own items too).
    "src/renderer/src/editor/panels/RightPanel.tsx",
    "      entries={entries}\n      head={(close) => <ZoomField",
    `      entries={${EMBED}?.viewMenu ? ${EMBED}.viewMenu(entries, ed) : entries}\n      head={(close) => <ZoomField`,
  ],
  [
    // header-actions: the Design panel header's buttons Studio keeps (no component, slot, dev status, link, variable).
    "src/renderer/src/editor/panels/design/Header.tsx",
    "  return <>{row.map(render)}</>;",
    `  return <>{row.filter((a) => ${EMBED}?.headerAction?.(a) !== false).map(render)}</>;`,
  ],
  [
    // tool-menus: the toolbar's tool menus without the tools Studio leaves out (Section, Slice …).
    "src/renderer/src/ds/components/EditorToolbar.tsx",
    "            menu={g.tools.map((id) => ({",
    `            menu={g.tools.filter((id) => ${EMBED}?.tool?.(id) !== false).map((id) => ({`,
  ],
  [
    // design-panel: no plugin relaunch buttons, page Export or MCP section with nothing selected …
    "src/renderer/src/editor/panels/design/DesignPanel.tsx",
    '          <RelaunchButtons refs={[page, "0:0"]} />\n',
    `          {!${EMBED}?.studio && <RelaunchButtons refs={[page, "0:0"]} />}\n`,
  ],
  [
    "src/renderer/src/editor/panels/design/DesignPanel.tsx",
    "          {pageNode && <ExportSection targets={[pageNode as ExportTarget]} page />}\n          <McpSection />\n",
    `          {!${EMBED}?.studio && pageNode && <ExportSection targets={[pageNode as ExportTarget]} page />}\n          {!${EMBED}?.studio && <McpSection />}\n`,
  ],
  [
    // … and no relaunch buttons or canvas buttons over a selection (its Export stays: Studio has none).
    "src/renderer/src/editor/panels/design/DesignPanel.tsx",
    "      <RelaunchButtons refs={nodes.map((n) => n.guid)} />\n",
    `      {!${EMBED}?.studio && <RelaunchButtons refs={nodes.map((n) => n.guid)} />}\n`,
  ],
  [
    "src/renderer/src/editor/panels/design/DesignPanel.tsx",
    "      <ButtonSection nodes={nodes} />\n",
    `      {!${EMBED}?.studio && <ButtonSection nodes={nodes} />}\n`,
  ],
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", repo, ...args], { encoding, maxBuffer: 512 * 1024 * 1024 });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

if (check) {
  const versionFile = join(OUT_DIR, "VERSION.json");
  if (!existsSync(versionFile)) {
    console.error(`vendor-wecra: nothing vendored at ${OUT_DIR} (run without --check)`);
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(versionFile, "utf8"));
  let bad = 0;
  for (const [file, hash] of Object.entries(version.files)) {
    const path = join(OUT_DIR, file);
    const actual = existsSync(path) ? sha256(readFileSync(path)) : "missing";
    if (actual !== hash) {
      console.error(`vendor-wecra: ${file} differs from VERSION.json (${actual.slice(0, 12)})`);
      bad++;
    }
  }
  const listed = new Set([...Object.keys(version.files), "VERSION.json"]);
  for (const path of walk(OUT_DIR)) {
    const file = relative(OUT_DIR, path).split(sep).join("/");
    if (!listed.has(file)) {
      console.error(`vendor-wecra: ${file} is not in VERSION.json`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(
    `vendor-wecra: ${Object.keys(version.files).length} files match ${version.commit.slice(0, 10)}`,
  );
  process.exit(0);
}

if (!existsSync(join(repo, ".git"))) {
  console.error(`vendor-wecra: no DesignerV2 checkout at ${repo} (pass --repo or WECRA_REPO)`);
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
  "src/renderer/src/engine/wasm",
]).trim();
const emsdk = git(["show", `${commit}:engine/EMSDK_VERSION`]).trim();
const appVersion = JSON.parse(git(["show", `${commit}:package.json`])).version;

// The tree at the commit, extracted to a temporary folder.
const tmp = mkdtempSync(join(tmpdir(), "wecra-vendor-"));
try {
  const tar = git(["archive", "--format=tar", commit, ...ROOTS], "buffer");
  execFileSync("tar", ["-x", "-C", tmp], { input: tar, maxBuffer: 512 * 1024 * 1024 });

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const files = {};
  const pending = new Map();
  for (const [file, a, b] of REWRITES) pending.set(file, [...(pending.get(file) ?? []), [a, b]]);
  let skipped = 0;
  for (const path of walk(tmp)) {
    const file = relative(tmp, path).split(sep).join("/");
    if (SKIP.some((re) => re.test(file))) {
      skipped++;
      continue;
    }
    let bytes = readFileSync(path);
    if (/\.(ts|tsx|mts|cts)$/.test(file)) {
      let text = bytes.toString("utf8");
      for (const [before, after] of pending.get(file) ?? []) {
        if (text.split(before).length !== 2)
          throw new Error(`vendor-wecra: ${file} no longer has (exactly once): ${before}`);
        text = text.replace(before, () => after);
      }
      pending.delete(file);
      text = `// @ts-nocheck\n// Vendored from Wecra (DesignerV2) ${commit.slice(0, 10)}:${file}. Do not edit: run apps/desktop/scripts/vendor-wecra.mjs.\n${text}`;
      bytes = Buffer.from(text, "utf8");
    }
    const to = join(OUT_DIR, file);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    files[file] = sha256(bytes);
  }
  if (pending.size) throw new Error(`vendor-wecra: not found: ${[...pending.keys()].join(", ")}`);

  // Wecra's DOM walker as a module: the same source, run with the window it is given (a slide's
  // iframe) instead of the page's globals.
  const walker = readFileSync(join(tmp, "src/shared/agents/web/walker.js"), "utf8");
  const walkerModule = `// Generated by apps/desktop/scripts/vendor-wecra.mjs from Wecra ${commit.slice(0, 10)}:src/shared/agents/web/walker.js. Do not edit.
// Installs Wecra's DOM walker on \`win\` (\`win.__uikit.capture(el)\` → the captured tree).
/* eslint-disable */
export function installWalker(win) {
  const window = win;
  const document = win.document;
  const getComputedStyle = win.getComputedStyle.bind(win);
  const SVGElement = win.SVGElement;
  const innerWidth = win.innerWidth;
  const innerHeight = win.innerHeight;
${walker}
  return win.__uikit;
}
`;
  mkdirSync(join(OUT_DIR, "studio"), { recursive: true });
  writeFileSync(join(OUT_DIR, "studio/walker.mjs"), walkerModule);
  files["studio/walker.mjs"] = sha256(Buffer.from(walkerModule, "utf8"));
  const walkerTypes = `// Generated by apps/desktop/scripts/vendor-wecra.mjs. Do not edit.
export function installWalker(win: Window): unknown;
`;
  writeFileSync(join(OUT_DIR, "studio/walker.d.mts"), walkerTypes);
  files["studio/walker.d.mts"] = sha256(Buffer.from(walkerTypes, "utf8"));

  // Wecra's compiler options for the copy (Vite's TypeScript transform reads the nearest
  // tsconfig.json: Wecra elides type-only imports, Studio's verbatimModuleSyntax would not).
  const tsconfig = `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        isolatedModules: true,
        verbatimModuleSyntax: false,
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        noEmit: true,
        paths: { "@/*": ["./src/renderer/src/*"], "@shared/*": ["./src/shared/*"] },
      },
      include: ["**/*"],
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(OUT_DIR, "tsconfig.json"), tsconfig);
  files["tsconfig.json"] = sha256(Buffer.from(tsconfig, "utf8"));

  const abi = /ABI_VERSION = (\d+)/.exec(
    readFileSync(join(OUT_DIR, "src/renderer/src/engine/abi.ts"), "utf8"),
  )?.[1];
  // What a saved document records about the Wecra that wrote it.
  const versionModule = `// Generated by apps/desktop/scripts/vendor-wecra.mjs. Do not edit.
export const WECRA_VERSION = ${JSON.stringify({ appVersion, commit, abiVersion: Number(abi) })} as const;
`;
  writeFileSync(join(OUT_DIR, "studio/version.ts"), versionModule);
  files["studio/version.ts"] = sha256(Buffer.from(versionModule, "utf8"));

  const version = {
    source: "Wecra (DesignerV2) — closed source, never committed to Studio",
    repo: "DesignerV2",
    appVersion,
    ref,
    commit,
    commitDate,
    engineCommit,
    abiVersion: Number(abi),
    emsdk,
    roots: ROOTS,
    rewrites: [...new Set(REWRITES.map(([file]) => file))],
    skippedTests: skipped,
    vendoredAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeFileSync(join(OUT_DIR, "VERSION.json"), `${JSON.stringify(version, null, 2)}\n`);
  console.log(
    `vendor-wecra: ${Object.keys(files).length} files from Wecra ${appVersion} (${commit.slice(0, 10)}, ${commitDate}) → ${relative(process.cwd(), OUT_DIR)}`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
