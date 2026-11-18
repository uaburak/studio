#!/usr/bin/env node
// Builds Studio.app (S3, P1): the app (electron-vite, Wecra's editor must be vendored), the
// self-contained host (build-host.mjs → out/host), the staged app folder (out/package: main,
// preload, renderer and a package.json without dependencies), then electron-builder
// (electron-builder.config.cjs) → release/mac-arm64/Studio.app + release/Studio-<version>-arm64.zip.
//
//   pnpm --filter @studio/desktop package            (root: pnpm package)
//   node scripts/package.mjs [--skip-build]          (reuse out/main, out/preload, out/renderer)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const out = join(desktop, "out");
const stage = join(out, "package");

function run(command, args, env = {}) {
  console.log(`[package] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: desktop,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`[package] ${command} failed (${result.status ?? result.error?.message})`);
    process.exit(result.status ?? 1);
  }
}

function size(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of readdirSync(path)) total += size(join(path, name));
  return total;
}

const bin = (name) => join(desktop, "node_modules", ".bin", name);

if (!process.argv.includes("--skip-build")) {
  // The packaged renderer must contain Wecra's editor: no STUDIO_WECRA_OPTIONAL here.
  run(process.execPath, [join(here, "wecra-guard.mjs"), "--", bin("electron-vite"), "build"], {
    STUDIO_WECRA_OPTIONAL: "",
  });
}
run(process.execPath, [join(here, "build-host.mjs")]);

// The app's own files, and a package.json without dependencies (nothing else goes in the asar).
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const part of ["main", "preload", "renderer"]) {
  cpSync(join(out, part), join(stage, part), { recursive: true });
}
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "studio",
      productName: "Studio",
      version: pkg.version,
      description: pkg.description,
      author: "Burak Koç",
      type: "module",
      main: "main/index.js",
    },
    null,
    2,
  )}\n`,
);

run(bin("electron-builder"), [
  "--config",
  "electron-builder.config.cjs",
  "--mac",
  "--arm64",
  "--publish",
  "never",
]);

const app = join(desktop, "release", "mac-arm64", "Studio.app");
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
console.log(`[package] ${app} (${mb(size(app))})`);
for (const name of readdirSync(join(desktop, "release"))) {
  if (/\.(zip|dmg)$/.test(name)) {
    console.log(`[package] ${join(desktop, "release", name)} (${mb(size(join(desktop, "release", name)))})`);
  }
}
