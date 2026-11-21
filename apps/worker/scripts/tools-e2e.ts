// Real end-to-end check of the in-app tool installs (contract TOOL_MANIFEST, src/tools): downloads
// each pinned tool from its official source into a TEMPORARY tools folder (never Studio's real
// state folder), verifies it (SHA-256, Developer ID team), unpacks it, links it into tools/bin and
// runs it from there. Network required.
//
//   pnpm -C apps/worker tools:e2e                 # ffmpeg, cloudflared, python
//   pnpm -C apps/worker tools:e2e ffmpeg          # one tool (also: gemini, claude ~345 MB)
//   STUDIO_TOOLS_E2E_PYPI=1 pnpm -C apps/worker tools:e2e python   # also pip-installs the code engine
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolId } from "@studio/contract";
import { readyRuntime, setupRuntime } from "../src/generate/code/runtime.ts";
import { ToolManager } from "../src/tools/manager.ts";
import { ownNodeRuntime } from "../src/tools/service.ts";

const wanted = (process.argv.slice(2) as ToolId[]).filter(Boolean);
const ids: ToolId[] = wanted.length > 0 ? wanted : ["ffmpeg", "cloudflared", "python"];
const root = mkdtempSync(path.join(tmpdir(), "studio-tools-e2e-"));
const toolsDir = path.join(root, "tools");
const stateDir = path.join(root, "worker");
const pypi = process.env.STUDIO_TOOLS_E2E_PYPI === "1";

const manager = new ToolManager({
  toolsDir,
  env: { PATH: "/usr/bin:/bin", HOME: root },
  node: ownNodeRuntime(),
  python: {
    systemPython: async () => null,
    ready: async () => pypi && (await readyRuntime(stateDir)) !== null,
    async setup(python, signal, log) {
      if (!pypi) {
        log("PyPI adımı atlandı (STUDIO_TOOLS_E2E_PYPI=1 ile çalışır)");
        return;
      }
      await setupRuntime(stateDir, { python, signal, log });
    },
    remove: async () => {},
  },
  log: (line) => console.log(`  · ${line}`),
});

let failed = 0;
for (const id of ids) {
  console.log(`\n== ${id}`);
  const started = Date.now();
  try {
    let last = -1;
    const result = await manager.install(id, {
      jobId: `e2e-${id}`,
      signal: AbortSignal.timeout(20 * 60_000),
      progress(value, message) {
        const pct = Math.floor(value * 10);
        if (pct !== last) {
          last = pct;
          console.log(`  ${Math.round(value * 100)}% ${message ?? ""}`);
        }
      },
    });
    console.log(`  ${result.message} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    const status = await manager.status(id);
    console.log(`  durum: ${status.state} ${status.version} ${status.location} ${status.path}`);
    const rec = manager.record(id);
    for (const [, name] of rec?.binaries ?? []) {
      const bin = path.join(manager.binDir, name);
      const args = id === "ffmpeg" ? ["-version"] : ["--version"];
      const out = execFileSync(bin, args, { encoding: "utf8" }).split("\n")[0];
      console.log(`  ${bin} ${args.join(" ")} → ${out}`);
    }
    if (status.state !== "installed" && !(id === "python" && !pypi)) {
      throw new Error(`durum ${status.state}`);
    }
  } catch (error) {
    failed++;
    console.error(`  HATA: ${(error as Error).message}`);
  }
}
if (process.env.STUDIO_TOOLS_E2E_KEEP !== "1") rmSync(root, { recursive: true, force: true });
else console.log(`\nklasör: ${root}`);
process.exit(failed > 0 ? 1 : 0);
