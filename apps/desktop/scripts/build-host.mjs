#!/usr/bin/env node
// Stages the self-contained host that Studio.app runs without the repo (S3, P1):
//
//   out/host/
//     manifest.json        what was built (version, latest migration, Chromium revision, …)
//     bin/node-shim.cjs    preloaded into every Node child run by Electron's own binary
//     api/index.js         the API Worker, bundled (`wrangler deploy --dry-run`)
//     api/wrangler.json    its configuration (paths filled in by the app at start)
//     api/migrations/      D1 migrations (*.sql)
//     gateway/lan-gateway.mjs
//     worker/main.js       the worker, bundled with esbuild (plain JS, no tsx)
//     agent/skills/        the chat agent's skills
//     node_modules/        wrangler (+ miniflare, workerd), sharp, playwright-core — copied
//                          from the workspace's pnpm store into an npm-style tree (no symlinks)
//
// electron-builder copies the folder to `Studio.app/Contents/Resources/host` (extraResources).
// Nothing here downloads anything: every package comes from the installed workspace.
//
//   node scripts/build-host.mjs [--out <dir>]
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "../..");
const apiDir = join(repo, "apps", "api");
const workerDir = join(repo, "apps", "worker");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
}

const out = argValue("--out", join(desktop, "out", "host"));

function log(message) {
  console.log(`[build-host] ${message}`);
}

function stripJsonComments(text) {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      result += c;
      if (c === "\\") {
        result += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      result += c;
    }
  }
  // Trailing commas (JSONC allows them).
  return result.replace(/,(\s*[}\]])/g, "$1");
}

// --- API ------------------------------------------------------------------------------------

function buildApi() {
  const dest = join(out, "api");
  mkdirSync(dest, { recursive: true });
  const tmp = join(out, ".api-build");
  rmSync(tmp, { recursive: true, force: true });
  const wrangler = join(apiDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = spawnSync(
    process.execPath,
    [wrangler, "deploy", "--dry-run", "--outdir", tmp],
    {
      cwd: apiDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_HIDE_BANNER: "true",
      },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error("wrangler deploy --dry-run failed");
  }
  for (const file of ["index.js", "index.js.map"]) {
    if (existsSync(join(tmp, file))) cpSync(join(tmp, file), join(dest, file));
  }
  rmSync(tmp, { recursive: true, force: true });

  const migrations = join(dest, "migrations");
  mkdirSync(migrations, { recursive: true });
  const sql = readdirSync(join(apiDir, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of sql) cpSync(join(apiDir, "migrations", f), join(migrations, f));

  // The repo's wrangler.jsonc, pointed at the bundle (no_bundle: wrangler runs it as built).
  const config = JSON.parse(stripJsonComments(readFileSync(join(apiDir, "wrangler.jsonc"), "utf8")));
  delete config.$schema;
  config.main = "index.js";
  config.no_bundle = true;
  config.send_metrics = false;
  for (const db of config.d1_databases ?? []) db.migrations_dir = "migrations";
  writeFileSync(join(dest, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
  return { latestMigration: sql.at(-1) ?? null, migrations: sql.length };
}

// --- worker ---------------------------------------------------------------------------------

async function buildWorker() {
  const dest = join(out, "worker");
  mkdirSync(dest, { recursive: true });
  await build({
    entryPoints: [join(workerDir, "src", "main.ts")],
    outfile: join(dest, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "warning",
    // Native / browser-driving packages stay real packages in host/node_modules.
    external: ["sharp", "playwright-core"],
    // CommonJS dependencies inside an ES module bundle still call `require`.
    banner: {
      js: 'import { createRequire as __studioCreateRequire } from "node:module"; const require = __studioCreateRequire(import.meta.url);',
    },
    absWorkingDir: workerDir,
  });
}

// --- node_modules: an npm-style copy of the pnpm packages the children need -------------------

const SKIP_FILE = /(\.d\.[cm]?ts|\.d\.ts\.map|\.md|\.markdown|\.tsbuildinfo)$/i;
/** Never copied, at any depth (pnpm's own links; CI files). */
const SKIP_DIR = new Set(["node_modules", ".github"]);
/** Not copied at a package's top level (tests and docs never run). */
const SKIP_TOP_DIR = new Set(["test", "tests", "__tests__", "docs", "doc", "example", "examples"]);

/** Node's lookup of `name` from a package's real folder (pnpm keeps dependencies as siblings). */
function resolveFrom(realDir, name) {
  let dir = realDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * Places every package reachable from `roots` (name → folder it is resolved from) under
 * `<out>/node_modules`: hoisted when the name is free, nested under the dependent otherwise.
 */
function collectModules(roots) {
  const top = join(out, "node_modules");
  /** dest folder → real folder */
  const placed = new Map();
  const queue = [];

  /** What Node would find for `name` from `fromDest` with the current placements. */
  function resolvedInDest(fromDest, name) {
    let dir = fromDest;
    while (dir.startsWith(out)) {
      if (basename(dir) !== "node_modules") {
        const candidate = join(dir, "node_modules", name);
        if (placed.has(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  function place(name, real, fromDest) {
    const found = resolvedInDest(fromDest, name);
    if (found && placed.get(found) === real) return;
    let dest;
    if (!found) {
      const hoisted = join(top, name);
      dest = placed.has(hoisted) ? join(fromDest, "node_modules", name) : hoisted;
    } else {
      dest = join(fromDest, "node_modules", name);
    }
    if (placed.has(dest)) {
      if (placed.get(dest) !== real) throw new Error(`conflicting placement for ${name} at ${dest}`);
      return;
    }
    placed.set(dest, real);
    queue.push({ dest, real });
  }

  for (const [name, from] of roots) {
    const real = resolveFrom(from, name);
    if (!real) throw new Error(`${name} is not installed (from ${from})`);
    place(name, real, out);
  }
  while (queue.length > 0) {
    const { dest, real } = queue.shift();
    const pkg = readPackage(real);
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((n) => !n.startsWith("@types/"));
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...optional, ...peers]);
    for (const dep of names) {
      const depReal = resolveFrom(real, dep);
      if (!depReal) {
        if (optional.has(dep) || peers.includes(dep)) continue;
        throw new Error(`${pkg.name} needs ${dep}, which is not installed`);
      }
      place(dep, depReal, dest);
    }
  }
  for (const [dest, real] of placed) {
    cpSync(real, dest, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const rel = relative(real, source);
        if (!rel) return true;
        const parts = rel.split(sep);
        if (parts.some((p) => SKIP_DIR.has(p))) return false;
        if (
          parts.length >= 1 &&
          SKIP_TOP_DIR.has(parts[0]) &&
          statSync(join(real, parts[0])).isDirectory()
        )
          return false;
        // workerd's install script copies its 150 MB binary into the wrapper package for the
        // `workerd` command; miniflare runs the platform package's own copy.
        if (basename(dest) === "workerd" && rel === join("bin", "workerd")) return false;
        return !SKIP_FILE.test(source) || basename(source).toLowerCase().startsWith("license");
      },
    });
  }
  return [...placed.keys()].map((d) => relative(top, d)).sort();
}

function folderSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += folderSize(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

// --- main -----------------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  log("API bundle");
  const api = buildApi();
  log("worker bundle");
  await buildWorker();

  mkdirSync(join(out, "gateway"), { recursive: true });
  cpSync(join(apiDir, "scripts", "lan-gateway.mjs"), join(out, "gateway", "lan-gateway.mjs"));
  mkdirSync(join(out, "bin"), { recursive: true });
  cpSync(join(desktop, "build", "node-shim.cjs"), join(out, "bin", "node-shim.cjs"));
  cpSync(join(repo, "agent", "skills"), join(out, "agent", "skills"), { recursive: true });

  log("node_modules");
  const modules = collectModules([
    ["wrangler", apiDir],
    ["sharp", workerDir],
    ["playwright-core", workerDir],
  ]);

  const browsers = JSON.parse(
    readFileSync(join(out, "node_modules", "playwright-core", "browsers.json"), "utf8"),
  );
  const shell = browsers.browsers.find((b) => b.name === "chromium-headless-shell");
  const desktopPkg = readPackage(desktop);
  const manifest = {
    version: desktopPkg.version,
    builtAt: new Date().toISOString(),
    latestMigration: api.latestMigration,
    migrations: api.migrations,
    wrangler: readPackage(join(out, "node_modules", "wrangler")).version,
    playwright: {
      version: readPackage(join(out, "node_modules", "playwright-core")).version,
      chromiumHeadlessShell: shell?.revision ?? null,
    },
    modules: modules.length,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const mb = (folderSize(out) / 1024 / 1024).toFixed(1);
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${out} (${mb} MB, ${modules.length} packages)`);
}

main().catch((error) => {
  console.error(`[build-host] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
