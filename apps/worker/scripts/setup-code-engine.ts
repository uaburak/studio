// The code engine's one-time setup (docs/URETIM-RESIM.md, Faz 4): builds the Python virtualenv
// the worker uses (`<state dir>/code-engine/venv`, pinned code-engine/requirements.txt) and runs
// a tiny program in the sandbox to prove it works. The worker does the same on first use; this is
// the path when that fails or to prepare a Mac ahead of time.
//
//   pnpm -C apps/worker code-engine:setup
//
// The state dir: STUDIO_STATE_DIR when set, else the Mac app's worker state dir
// (~/Library/Application Support/Studio/worker) when it exists, else the worker's default.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { readyRuntime, setupRuntime } from "../src/generate/code/runtime.ts";
import { createJobDir, runInSandbox } from "../src/generate/code/sandbox.ts";

// The Mac app runs the worker with its own state dir; prepare that one unless told otherwise.
const appStateDir = path.join(homedir(), "Library", "Application Support", "Studio", "worker");
const stateDir =
  process.env.STUDIO_STATE_DIR || !existsSync(appStateDir)
    ? loadConfig(process.env).stateDir
    : appStateDir;
console.log(`Durum klasörü: ${stateDir}`);
const runtime =
  (await readyRuntime(stateDir)) ??
  (await setupRuntime(stateDir, { log: (line) => console.log(`  ${line}`) }));
console.log(`Python ${runtime.version}: ${runtime.python}`);

const jobDir = await createJobDir(path.join(stateDir, "code-engine", "runs"), "setup-check");
const res = await runInSandbox({
  runtime,
  jobDir,
  program: [
    "import studio_brand as sb",
    "img = sb.canvas(1, background='#F4EFE4')",
    "sb.text(img, sb.SAFE_LEFT, 200, 'Kod motoru hazır', role='text', size=64, color='#1E3A2B', max_width=sb.SAFE_WIDTH, id='headline')",
    "sb.save(img)",
  ].join("\n"),
  input: {
    artboard: { width: 1080, height: 1350 },
    safeArea: { top: 80, right: 80, bottom: 80, left: 80 },
    colors: { paper: "#F4EFE4", ink: "#1E3A2B" },
    usage: { background: "paper", text: "ink" },
    fonts: { text: { family: "Helvetica Neue", files: [], defaultWeight: 700 } },
    pictures: [],
    slides: { min: 1, max: 1 },
  },
  timeoutMs: 60_000,
});
if (res.status !== "ok" || !res.slides.has(1)) {
  console.error(`Deneme programı çalışmadı (${res.status}):\n${res.stderr.slice(-2000)}`);
  process.exit(1);
}
const png = await readFile(res.slides.get(1) as string);
console.log(`Kapalı alanda deneme tamam (${res.durationMs} ms, ${png.byteLength} bayt PNG).`);
