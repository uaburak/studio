#!/usr/bin/env node
// build/icon.svg → build/icon.icns (macOS `iconutil`) + build/icon.png (1024 px).
// Rasterised with the worker's sharp (librsvg); run again after replacing the SVG.
//
//   node scripts/make-icon.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const build = resolve(here, "..", "build");
const require = createRequire(join(here, "..", "..", "worker", "package.json"));
const sharp = require("sharp");

const svg = readFileSync(join(build, "icon.svg"));
const set = join(tmpdir(), `studio-icon-${process.pid}.iconset`);
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of sizes) {
  const png = await sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
  const write = (name) => sharp(png).toFile(join(set, name));
  if (size <= 512) await write(`icon_${size}x${size}.png`);
  if (size >= 32) await write(`icon_${size / 2}x${size / 2}@2x.png`);
}
await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(join(build, "icon.png"));
execFileSync("/usr/bin/iconutil", ["-c", "icns", set, "-o", join(build, "icon.icns")]);
rmSync(set, { recursive: true, force: true });
console.log(`[make-icon] ${join(build, "icon.icns")}`);
