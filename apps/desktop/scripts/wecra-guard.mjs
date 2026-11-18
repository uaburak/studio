#!/usr/bin/env node
// Runs one of the desktop's commands (typecheck, test, build) only when Wecra's editor is
// vendored here (E18). The copy is gitignored (Wecra is closed source, Studio's repository is
// public), so a clean checkout doesn't have it: without this guard the renderer's typecheck,
// tests and build fail with hundreds of "cannot find module '@/…'" errors instead of saying what
// to do.
//
//   node scripts/wecra-guard.mjs [--without "<command>"] -- <command> [args…]
//
//   - vendored: `vendor-wecra.mjs --check` first (the copy matches its VERSION.json), then the
//     command — its exit code is the guard's;
//   - not vendored: says how to vendor it (Turkish and English) and stops with 1 — unless
//     `STUDIO_WECRA_OPTIONAL=1` (the root's `pnpm typecheck` / `test` / `build` set it, so the
//     rest of the monorepo keeps going): then the desktop's part is reported as skipped (0), and
//     `--without <command>` runs instead when given (the main process's tests need no Wecra).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const VENDORED = join(desktop, "src/renderer/vendor/wecra-editor/VERSION.json");

const MISSING_MESSAGE = [
  "Wecra düzenleyicisi bu kopyada yok (apps/desktop/src/renderer/vendor/wecra-editor; git'e girmez, Wecra kapalı kaynak).",
  "DesignerV2 bu deponun yanındayken (../DesignerV2) kopyalayın:",
  "    node apps/desktop/scripts/vendor-wecra.mjs",
  "Başka bir yerdeyse: --repo <DesignerV2 yolu> ya da WECRA_REPO=<yol>.",
  "",
  "Wecra's editor is not vendored on this checkout (apps/desktop/src/renderer/vendor/wecra-editor;",
  "gitignored, Wecra is closed source). With DesignerV2 next to this repository (../DesignerV2) run:",
  "    node apps/desktop/scripts/vendor-wecra.mjs",
  "Elsewhere: --repo <path to DesignerV2> or WECRA_REPO=<path>.",
].join("\n");

/** `[--without "<command>"] -- <command…>` */
function parseArgs(argv) {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : [];
  const command = dash >= 0 ? argv.slice(dash + 1) : argv;
  const w = own.indexOf("--without");
  const without = w >= 0 && own[w + 1] ? own[w + 1].split(/\s+/).filter(Boolean) : null;
  return { command, without };
}

function run(command) {
  const [cmd, ...args] = command;
  if (!cmd) return 0;
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: desktop });
  if (r.error) {
    console.error(`wecra-guard: ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function main() {
  const { command, without } = parseArgs(process.argv.slice(2));
  const label = command.join(" ") || "(nothing)";
  if (!existsSync(VENDORED)) {
    const optional = process.env.STUDIO_WECRA_OPTIONAL === "1";
    console.error(`\n${MISSING_MESSAGE}\n`);
    if (!optional) {
      console.error(`@studio/desktop: "${label}" çalıştırılmadı / not run (exit 1).\n`);
      return 1;
    }
    console.error(
      `@studio/desktop: "${label}" atlandı / skipped${
        without ? ` — yalnızca / only: ${without.join(" ")}` : ""
      }.\n`,
    );
    return without ? run(without) : 0;
  }
  // The copy must be the one VERSION.json records (never edited by hand).
  const check = spawnSync(process.execPath, [join(here, "vendor-wecra.mjs"), "--check"], {
    cwd: desktop,
    encoding: "utf8",
  });
  if (check.status !== 0) {
    process.stderr.write(check.stderr ?? "");
    console.error(
      "\nWecra kopyası VERSION.json ile eşleşmiyor; elle değiştirilmiş olabilir. Yeniden kopyalayın:\n" +
        "    node apps/desktop/scripts/vendor-wecra.mjs\n" +
        "The vendored Wecra differs from its VERSION.json (edited by hand?). Vendor it again (above).\n",
    );
    return 1;
  }
  return run(command);
}

process.exit(main());
