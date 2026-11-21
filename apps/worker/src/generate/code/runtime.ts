/**
 * The code engine's Python runtime (docs/URETIM-RESIM.md, Faz 4).
 *
 * A project-local virtualenv under the worker's state dir — `<stateDir>/code-engine/venv` — built
 * from Studio's own Python (Ayarlar → Gelişmiş → Araçlar → Python, a python-build-standalone build
 * in `tools/`, tools/manager.ts) or else the Mac's own `python3` (Homebrew's, else the Command
 * Line Tools' — never the stub that would open the installer dialog), with
 * the pinned `apps/worker/code-engine/requirements.txt` (Pillow, numpy, OpenCV headless,
 * skia-python; wheels only). Nothing is installed globally and nothing needs sudo.
 *
 * The worker builds it on demand the first time a code job runs (about a minute: the wheels are
 * downloaded once) and records it in `<stateDir>/code-engine/runtime.json` with the requirements'
 * hash, so a changed requirements file rebuilds it. `pnpm -C apps/worker code-engine:setup` does
 * the same from a terminal (the one-time setup path when the automatic one fails).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedExecutable } from "../../tools/paths.ts";

/** Studio's own Python's name in `tools/bin` (contract TOOL_MANIFEST `python`). */
export const MANAGED_PYTHON = "studio-python3";

/** The helper files the sandbox gets a copy of (code-engine/). */
export const CODE_ENGINE_FILES = ["run.py", "studio_brand.py"] as const;

export interface CodeRuntime {
  /** `<venv>/bin/python` (what the sandbox runs). */
  python: string;
  /** The virtualenv (real path). */
  venv: string;
  /** The base Python the venv was made from: its prefix and the real interpreter binary. */
  basePrefix: string;
  executable: string;
  /** "3.9.6". */
  version: string;
  /** The folder with run.py, studio_brand.py, requirements.txt. */
  engineDir: string;
}

export interface RuntimeRecord {
  python: string;
  venv: string;
  basePrefix: string;
  executable: string;
  version: string;
  requirements: string;
  createdAt: string;
}

/** `apps/worker/code-engine` (dev: next to src; packaged: next to the bundled main.js). */
export function codeEngineDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.STUDIO_CODE_ENGINE_DIR,
    fileURLToPath(new URL("../../../code-engine/", import.meta.url)),
    fileURLToPath(new URL("./code-engine/", import.meta.url)),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const dir of candidates) {
    if (CODE_ENGINE_FILES.every((f) => existsSync(path.join(dir, f)))) return path.resolve(dir);
  }
  return null;
}

export function runtimeRoot(stateDir: string): string {
  return path.join(stateDir, "code-engine");
}

async function requirementsHash(engineDir: string): Promise<string> {
  const text = await readFile(path.join(engineDir, "requirements.txt"), "utf8");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command without a shell; output capped; killed after `timeoutMs`. */
export function execFileCapped(
  file: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    signal?: AbortSignal;
    maxOutput?: number;
  },
): Promise<Exec> {
  const max = options.maxOutput ?? 256_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? { PATH: "/usr/bin:/bin" },
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr = (stderr + d.toString("utf8")).slice(-max);
    });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The Command Line Tools / Xcode are there (else /usr/bin/python3 would ask to install them). */
async function developerToolsInstalled(): Promise<boolean> {
  try {
    const res = await execFileCapped("/usr/bin/xcode-select", ["-p"], { timeoutMs: 10_000 });
    return res.code === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface PythonInfo {
  python: string;
  version: string;
  basePrefix: string;
  executable: string;
}

const PROBE =
  "import json, os, sys; print(json.dumps({'version': '%d.%d.%d' % sys.version_info[:3], 'ok': sys.version_info >= (3, 9), 'prefix': sys.base_prefix, 'executable': os.path.realpath(sys.executable)}))";

async function probePython(python: string): Promise<PythonInfo | null> {
  try {
    const res = await execFileCapped(python, ["-I", "-c", PROBE], { timeoutMs: 20_000 });
    if (res.code !== 0) return null;
    const info = JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
    if (info.ok !== true || typeof info.version !== "string") return null;
    return {
      python,
      version: info.version,
      basePrefix: String(info.prefix),
      executable: String(info.executable),
    };
  } catch {
    return null;
  }
}

/**
 * The Python the code engine is built from: Studio's own (`tools/bin/studio-python3`) first, else
 * the Mac's (`findMacPython`).
 */
export async function findSystemPython(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonInfo | null> {
  if (!env.STUDIO_CODE_PYTHON) {
    const managed = managedExecutable(MANAGED_PYTHON, env);
    if (managed) {
      const info = await probePython(managed);
      if (info) return info;
    }
  }
  return findMacPython(env);
}

/**
 * The Mac's Python 3 (3.9 or newer): `STUDIO_CODE_PYTHON`, Homebrew's, then the Command Line
 * Tools' `/usr/bin/python3` (only when the tools are installed: the stub would open a dialog).
 */
export async function findMacPython(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonInfo | null> {
  const candidates = [
    env.STUDIO_CODE_PYTHON,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const info = await probePython(p);
    if (info) return info;
  }
  if (existsSync("/usr/bin/python3") && (await developerToolsInstalled()))
    return probePython("/usr/bin/python3");
  return null;
}

/** The recorded runtime when it is still usable (same requirements, the interpreter there). */
export async function readyRuntime(stateDir: string): Promise<CodeRuntime | null> {
  const engineDir = codeEngineDir();
  if (!engineDir) return null;
  let record: RuntimeRecord;
  try {
    record = JSON.parse(
      await readFile(path.join(runtimeRoot(stateDir), "runtime.json"), "utf8"),
    ) as RuntimeRecord;
  } catch {
    return null;
  }
  if (record.requirements !== (await requirementsHash(engineDir))) return null;
  if (!existsSync(record.python) || !existsSync(record.executable)) return null;
  return {
    python: record.python,
    venv: record.venv,
    basePrefix: record.basePrefix,
    executable: record.executable,
    version: record.version,
    engineDir,
  };
}

export class CodeRuntimeError extends Error {
  override name = "CodeRuntimeError";
}

/** The one-time setup path, in the messages. */
export const SETUP_HINT =
  "Python gerekli · Ayarlar → Gelişmiş → Araçlar → Python'dan Kur (ya da sohbette “Python'u kur” de).";

/**
 * Build the virtualenv (or rebuild it when the requirements changed): `python3 -m venv`, then
 * `pip install --only-binary=:all: -r requirements.txt`, then an import check. Throws
 * `CodeRuntimeError` (Turkish) on failure.
 */
export async function setupRuntime(
  stateDir: string,
  options: { signal?: AbortSignal; log?: (line: string) => void; python?: string } = {},
): Promise<CodeRuntime> {
  const log = options.log ?? (() => {});
  const engineDir = codeEngineDir();
  if (!engineDir)
    throw new CodeRuntimeError(
      "Kod motoru için Python ortamı hazır değil: motorun dosyaları (apps/worker/code-engine) bulunamadı.",
    );
  const base = options.python ? await probePython(options.python) : await findSystemPython();
  if (!base)
    throw new CodeRuntimeError(
      `Kod motoru için Python ortamı hazır değil: bu Mac'te Python 3 (3.9 ya da yenisi) bulunamadı. ${SETUP_HINT}`,
    );
  const root = runtimeRoot(stateDir);
  await mkdir(root, { recursive: true });
  const venv = path.join(root, "venv");
  const building = path.join(root, `venv-building-${process.pid}`);
  await rm(building, { recursive: true, force: true });
  const env = { PATH: "/usr/bin:/bin", HOME: root, LANG: "en_US.UTF-8", PIP_NO_INPUT: "1" };
  const step = async (label: string, file: string, args: string[], timeoutMs: number) => {
    log(`${label}…`);
    const res = await execFileCapped(file, args, {
      timeoutMs,
      env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      cwd: root,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (res.code !== 0)
      throw new CodeRuntimeError(
        `Kod motoru için Python ortamı hazır değil; kurulamadı (${label}): ${(res.stderr || res.stdout).trim().slice(-600)} ${SETUP_HINT}`,
      );
    return res;
  };
  log(`Python ${base.version} (${base.python})`);
  await step("venv", base.python, ["-m", "venv", building], 120_000);
  const py = path.join(building, "bin", "python");
  await step("pip", py, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], 300_000);
  await step(
    "paketler",
    py,
    [
      "-m",
      "pip",
      "install",
      "--quiet",
      "--only-binary=:all:",
      "-r",
      path.join(engineDir, "requirements.txt"),
    ],
    900_000,
  );
  await step(
    "deneme",
    py,
    ["-I", "-c", "import PIL, numpy, cv2, skia; print(PIL.__version__, numpy.__version__)"],
    120_000,
  );
  // A venv records its own path in its scripts: move it in place, then rebuild that path's view
  // by asking the moved interpreter (pyvenv.cfg holds only the base, so the move is safe).
  await rm(venv, { recursive: true, force: true });
  await rename(building, venv);
  const realVenv = await realpath(venv);
  const python = path.join(realVenv, "bin", "python");
  const moved = await probePython(python);
  if (!moved)
    throw new CodeRuntimeError(
      `Kod motoru için Python ortamı hazır değil: kurulan ortam açılamadı. ${SETUP_HINT}`,
    );
  const record: RuntimeRecord = {
    python,
    venv: realVenv,
    basePrefix: await realpath(moved.basePrefix),
    executable: moved.executable,
    version: moved.version,
    requirements: await requirementsHash(engineDir),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, "runtime.json"), `${JSON.stringify(record, null, 2)}\n`);
  log(`hazır: ${realVenv}`);
  return {
    python,
    venv: realVenv,
    basePrefix: record.basePrefix,
    executable: record.executable,
    version: record.version,
    engineDir,
  };
}

const preparing = new Map<string, Promise<CodeRuntime>>();

/**
 * The runtime, building it the first time (one build per state dir at a time; a failed build is
 * tried again by the next job). `onWait` tells the job it is waiting for the setup.
 */
export async function ensureCodeRuntime(
  stateDir: string,
  options: { signal?: AbortSignal; onWait?: () => void; log?: (line: string) => void } = {},
): Promise<CodeRuntime> {
  const ready = await readyRuntime(stateDir);
  if (ready) return ready;
  let p = preparing.get(stateDir);
  if (!p) {
    p = setupRuntime(stateDir, options.log ? { log: options.log } : {}).finally(() =>
      preparing.delete(stateDir),
    );
    preparing.set(stateDir, p);
  }
  options.onWait?.();
  if (!options.signal) return p;
  const signal = options.signal;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}
