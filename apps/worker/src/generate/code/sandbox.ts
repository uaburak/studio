/**
 * The code engine's closed room (docs/URETIM-RESIM.md, decision 4): one post program runs in a
 * macOS `sandbox-exec` profile.
 *
 *   job dir (realpath)/
 *     input/   read only — input.json, program.py, lib/ (run.py, studio_brand.py), fonts/, pictures/
 *     out/     write — slide-N.png, record.json
 *     tmp/     write — HOME and TMPDIR of the program
 *
 * The profile denies everything, then allows: reading the virtualenv, the base Python, the job's
 * input folder, the system's libraries and fonts; writing only `out/` and `tmp/`; running only
 * the Python binary (no fork); outbound network (no listening, no inbound); nothing of the user's
 * home but the job dir. The environment is stripped (no tokens or keys), the process has a wall
 * clock limit (its whole process group is killed), a memory ceiling (resident size polled) and a
 * file size limit; stdout/stderr are capped. `run.py` refuses programs beyond drawing first
 * (`check.ts` is the same check in TypeScript, before anything is spawned).
 */
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { CODE_ENGINE_FILES, type CodeRuntime } from "./runtime.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_MEMORY_MB = 2_048;
/** Every file the program writes (RLIMIT_FSIZE in run.py: 64 MB) and the whole out/ folder. */
export const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const MAX_STREAM = 64 * 1024;

export interface SandboxPaths {
  /** Every path the interpreter's symlinks pass through (venv/bin/python → … → the binary). */
  pythonChain: string[];
  venv: string;
  basePrefix: string;
  executable: string;
  python: string;
  jobDir: string;
  inputDir: string;
  outDir: string;
  tmpDir: string;
}

/** An SBPL string literal. */
function lit(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Every ancestor folder of a path (their metadata is read while resolving it). */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(p);
  while (dir && dir !== "/" && !out.includes(dir)) {
    out.push(dir);
    dir = path.dirname(dir);
  }
  return out;
}

/** The sandbox profile for one run (all paths absolute and resolved). */
export function sandboxProfile(p: SandboxPaths): string {
  const readTrees = [p.venv, p.basePrefix, p.inputDir, p.outDir, p.tmpDir];
  const metaLiterals = [
    ...new Set(
      [...readTrees, p.executable, p.python, ...p.pythonChain]
        .flatMap((x) => ancestors(x))
        .concat(["/"]),
    ),
  ];
  const chain = [...new Set([p.python, ...p.pythonChain, p.executable])];
  return `(version 1)
(deny default)
; Only the Python interpreter runs (a framework build re-executes its own app); no fork.
(allow process-exec ${chain.map((c) => `(literal ${lit(c)})`).join(" ")} (subpath ${lit(p.basePrefix)}))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
; Reading: the system's libraries and fonts, the virtualenv, Python, the job's own folders.
(allow file-read-metadata
  ${metaLiterals.map((d) => `(literal ${lit(d)})`).join("\n  ")}
  (subpath "/System") (subpath "/usr") (subpath "/Library/Fonts") (subpath "/private/var/db")
  (subpath "/dev"))
(allow file-read*
  (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/Library/Fonts") (subpath "/private/var/db/timezone")
  (literal "/private/etc/localtime")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
  (subpath ${lit(p.venv)})
  (subpath ${lit(p.basePrefix)})
  ${chain.map((c) => `(literal ${lit(c)})`).join(" ")}
  (subpath ${lit(p.inputDir)})
  (subpath ${lit(p.outDir)})
  (subpath ${lit(p.tmpDir)}))
; Writing: only the job's output and temp folders.
(allow file-write*
  (subpath ${lit(p.outDir)})
  (subpath ${lit(p.tmpDir)})
  (literal "/dev/null"))
; Network: outbound only (no listening, no inbound), DNS through mDNSResponder.
(allow network-outbound (remote ip))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
`;
}

/** The paths a symlink passes through to its file (the link itself first). */
export async function symlinkChain(p: string): Promise<string[]> {
  const out: string[] = [];
  let current = p;
  for (let i = 0; i < 16; i++) {
    out.push(current);
    let target: string;
    try {
      target = await readlink(current);
    } catch {
      break;
    }
    current = path.resolve(path.dirname(current), target);
  }
  const real = await realpath(p).catch(() => null);
  if (real && !out.includes(real)) out.push(real);
  return out;
}

/** The job's folders (created; real paths, as the sandbox compares them). */
export async function createJobDir(root: string, name: string): Promise<SandboxPaths["jobDir"]> {
  await mkdir(root, { recursive: true });
  const jobDir = path.join(await realpath(root), name.replace(/[^A-Za-z0-9_.-]/g, "_"));
  await rm(jobDir, { recursive: true, force: true });
  for (const sub of ["input/lib", "input/fonts", "input/pictures", "out", "tmp"])
    await mkdir(path.join(jobDir, sub), { recursive: true });
  return jobDir;
}

export type SandboxStatus = "ok" | "error" | "rejected" | "timeout" | "memory" | "failed";

export interface SandboxResult {
  status: SandboxStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The program's traceback (status "error"). */
  traceback: string | null;
  /** The static check's findings (status "rejected"). */
  problems: string[];
  /** `out/slide-N.png` by slide number. */
  slides: Map<number, string>;
  /** `out/record.json` as written by studio_brand (null: none). */
  record: unknown | null;
  /** Files in out/ that are not slides or the record (ignored). */
  extraFiles: string[];
  durationMs: number;
}

export interface SandboxRunRequest {
  runtime: Pick<CodeRuntime, "python" | "venv" | "basePrefix" | "executable" | "engineDir">;
  jobDir: string;
  program: string;
  /** Written to input/input.json (`outputDir` is filled in). */
  input: Record<string, unknown>;
  timeoutMs?: number;
  maxMemoryMb?: number;
  signal?: AbortSignal;
}

/** Resident memory (MB) of a process, null when it is gone. */
function rssMb(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const ps = spawn("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let out = "";
    ps.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    ps.on("error", () => resolve(null));
    ps.on("close", () => {
      const kb = Number.parseInt(out.trim(), 10);
      resolve(Number.isFinite(kb) ? kb / 1024 : null);
    });
  });
}

/** Run the program in the sandbox; never throws for what the program does. */
export async function runInSandbox(req: SandboxRunRequest): Promise<SandboxResult> {
  const jobDir = await realpath(req.jobDir);
  const inputDir = path.join(jobDir, "input");
  const outDir = path.join(jobDir, "out");
  const tmpDir = path.join(jobDir, "tmp");
  const libDir = path.join(inputDir, "lib");
  for (const f of CODE_ENGINE_FILES)
    await copyFile(path.join(req.runtime.engineDir, f), path.join(libDir, f));
  const programPath = path.join(inputDir, "program.py");
  const inputPath = path.join(inputDir, "input.json");
  await writeFile(programPath, req.program);
  await writeFile(inputPath, JSON.stringify({ ...req.input, outputDir: outDir }));
  // A previous pass's output never counts for this one.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const profile = sandboxProfile({
    pythonChain: await symlinkChain(req.runtime.python),
    venv: await realpath(req.runtime.venv),
    basePrefix: await realpath(req.runtime.basePrefix),
    executable: req.runtime.executable,
    python: req.runtime.python,
    jobDir,
    inputDir,
    outDir,
    tmpDir,
  });
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMemoryMb = req.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  // A stripped environment: nothing of the worker's (tokens, keys) reaches the program.
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: tmpDir,
    TMPDIR: `${tmpDir}/`,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "0",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
    OPENCV_IO_ENABLE_OPENEXR: "0",
    STUDIO_CODE_CPU_S: String(Math.ceil((timeoutMs / 1000) * 2)),
  };
  const started = Date.now();
  const child = spawn(
    SANDBOX_EXEC,
    [
      "-p",
      profile,
      req.runtime.python,
      "-I",
      "-B",
      path.join(libDir, "run.py"),
      libDir,
      inputPath,
      programPath,
    ],
    { cwd: tmpDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    if (stdout.length < MAX_STREAM) stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-MAX_STREAM);
  });
  let killedFor: "timeout" | "memory" | "abort" | null = null;
  const killTree = (why: "timeout" | "memory" | "abort") => {
    killedFor ??= why;
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => killTree("timeout"), timeoutMs);
  const onAbort = () => killTree("abort");
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const poll = setInterval(() => {
    if (!child.pid) return;
    void rssMb(child.pid).then((mb) => {
      if (mb !== null && mb > maxMemoryMb) killTree("memory");
    });
  }, 250);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code, sig) => {
      if (sig) stderr += `\n[ended by ${sig}]`;
      resolve(code);
    });
  });
  clearTimeout(timer);
  clearInterval(poll);
  req.signal?.removeEventListener("abort", onAbort);
  // Whatever the program left running in its group goes too.
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
  req.signal?.throwIfAborted();

  const slides = new Map<number, string>();
  const extraFiles: string[] = [];
  let record: unknown | null = null;
  let total = 0;
  for (const name of await readdir(outDir).catch(() => [] as string[])) {
    const file = path.join(outDir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    total += info.size;
    const m = /^slide-(\d{1,2})\.png$/.exec(name);
    if (m) slides.set(Number(m[1]), file);
    else if (name === "record.json") {
      try {
        record = JSON.parse(await readFile(file, "utf8"));
      } catch {
        record = null;
      }
    } else if (!name.startsWith(".")) extraFiles.push(name);
  }
  const check = /@@STUDIO_CHECK@@ (\{.*\})/.exec(stderr);
  let problems: string[] = [];
  if (check?.[1]) {
    try {
      problems = (JSON.parse(check[1]) as { problems?: string[] }).problems ?? [];
    } catch {
      problems = ["the static check refused the program"];
    }
  }
  const status: SandboxStatus =
    killedFor === "timeout"
      ? "timeout"
      : killedFor === "memory"
        ? "memory"
        : total > MAX_OUTPUT_BYTES
          ? "failed"
          : exitCode === 0
            ? "ok"
            : exitCode === 3
              ? "rejected"
              : exitCode === 1
                ? "error"
                : "failed";
  return {
    status,
    exitCode,
    stdout,
    stderr,
    traceback: status === "error" ? stderr.trim().slice(-8_000) : null,
    problems,
    slides,
    record,
    extraFiles,
    durationMs: Date.now() - started,
  };
}
