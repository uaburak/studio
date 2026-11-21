// The worker's tool manager with the real hooks (Chromium through the bundled Playwright, the code
// engine's Python, whisper.cpp) and the `tool.install` / `tool.uninstall` job handlers.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import {
  ToolInstallPayload,
  type ToolJobOutput,
  type ToolStatus,
  ToolUninstallPayload,
} from "@studio/contract";
import {
  findMacPython,
  readyRuntime,
  runtimeRoot,
  setupRuntime,
} from "../generate/code/runtime.ts";
import { defineHandler, type JobHandlerDefinition } from "../registry.ts";
import { resolveWhisperBin, resolveWhisperModel } from "../video/transcribe.ts";
import { parseInstallProgress } from "./download.ts";
import { type ChromiumHooks, ToolManager, type ToolManagerOptions } from "./manager.ts";
import { workerToolsDir } from "./paths.ts";

/** How this process runs Node (the packaged app: Electron in Node mode with its shim). */
export function ownNodeRuntime(): {
  executable: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    executable: process.execPath,
    args: process.execArgv.filter((a) => a.startsWith("--require=") && a.includes("node-shim")),
    env: process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

function playwrightDir(): string | null {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

/** Chromium (Playwright's headless shell) for this worker's playwright-core. */
export function chromiumHooks(
  toolsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ChromiumHooks {
  const studioDir = path.join(path.dirname(toolsDir), "browsers");
  const target = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || studioDir;
  const cache = path.join(env.HOME || homedir(), "Library", "Caches", "ms-playwright");
  const revision = (): string | null => {
    const dir = playwrightDir();
    if (!dir) return null;
    try {
      const data = JSON.parse(readFileSync(path.join(dir, "browsers.json"), "utf8")) as {
        browsers?: { name?: string; revision?: string }[];
      };
      return data.browsers?.find((b) => b.name === "chromium-headless-shell")?.revision ?? null;
    } catch {
      return null;
    }
  };
  const shell = (dir: string, rev: string) => path.join(dir, `chromium_headless_shell-${rev}`);
  const has = (dir: string, rev: string) =>
    existsSync(path.join(shell(dir, rev), "INSTALLATION_COMPLETE"));
  return {
    revision,
    find() {
      const rev = revision();
      if (!rev) return null;
      if (has(target, rev)) {
        return {
          path: shell(target, rev),
          location: path.resolve(target) === path.resolve(studioDir) ? "studio" : "system",
        };
      }
      if (!env.PLAYWRIGHT_BROWSERS_PATH && has(cache, rev)) {
        return { path: shell(cache, rev), location: "system" };
      }
      return null;
    },
    install(onProgress, signal) {
      const dir = playwrightDir();
      if (!dir) return Promise.reject(new Error("playwright-core bulunamadı."));
      const node = ownNodeRuntime();
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          node.executable,
          [...node.args, path.join(dir, "cli.js"), "install", "--only-shell", "chromium"],
          {
            env: {
              PATH: env.PATH ?? "/usr/bin:/bin",
              HOME: env.HOME ?? homedir(),
              ...node.env,
              PLAYWRIGHT_BROWSERS_PATH: target,
            },
            stdio: ["ignore", "pipe", "pipe"],
            signal,
          },
        );
        let tail = "";
        const onData = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          tail = (tail + text).slice(-600);
          const pct = parseInstallProgress(text);
          if (pct !== null) onProgress(pct / 100);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Chromium kurulamadı (çıkış ${code}): ${tail.trim().slice(-300)}`)),
        );
      });
    },
    async remove() {
      const rev = revision();
      if (rev) await rm(shell(studioDir, rev), { recursive: true, force: true });
    },
  };
}

export interface ToolServiceOptions {
  /** The worker's state dir (the code engine's venv lives there). */
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** After Claude Code / Gemini CLI changed: re-read their sign-in so capabilities follow. */
  afterChange?: (toolId: ToolStatus["id"]) => Promise<void> | void;
  /** Test seams. */
  overrides?: Partial<ToolManagerOptions>;
}

export class ToolService {
  readonly manager: ToolManager;

  constructor(private readonly o: ToolServiceOptions) {
    const env = o.env ?? process.env;
    const toolsDir = o.overrides?.toolsDir ?? workerToolsDir(env);
    this.manager = new ToolManager({
      toolsDir,
      env,
      node: ownNodeRuntime(),
      chromium: chromiumHooks(toolsDir, env),
      python: {
        async systemPython() {
          const info = await findMacPython(env);
          return info ? { python: info.python, version: info.version } : null;
        },
        ready: async () => (await readyRuntime(o.stateDir)) !== null,
        async setup(python, signal, log) {
          await setupRuntime(o.stateDir, { python, signal, log });
        },
        async remove() {
          await rm(runtimeRoot(o.stateDir), { recursive: true, force: true });
        },
      },
      whisper: {
        binary: () => resolveWhisperBin(env),
        model: () => resolveWhisperModel(env),
      },
      ...(o.log ? { log: o.log } : {}),
      ...(o.overrides ?? {}),
    });
    this.manager.cleanLeftovers();
  }

  snapshot(): Promise<ToolStatus[]> {
    return this.manager.statuses();
  }

  installHandler(): JobHandlerDefinition<ToolInstallPayload, ToolJobOutput> {
    return defineHandler({
      payload: ToolInstallPayload,
      run: async (payload, ctx): Promise<ToolJobOutput> => {
        const result = await this.manager.install(
          payload.toolId,
          { jobId: ctx.jobId, signal: ctx.signal, progress: (v, m) => ctx.progress(v, m) },
          payload.update ? { update: true } : {},
        );
        ctx.log(result.message);
        await this.o.afterChange?.(payload.toolId);
        return result;
      },
    });
  }

  uninstallHandler(): JobHandlerDefinition<ToolUninstallPayload, ToolJobOutput> {
    return defineHandler({
      payload: ToolUninstallPayload,
      run: async (payload, ctx): Promise<ToolJobOutput> => {
        const result = await this.manager.uninstall(payload.toolId, {
          jobId: ctx.jobId,
          signal: ctx.signal,
          progress: (v, m) => ctx.progress(v, m),
        });
        ctx.log(result.message);
        await this.o.afterChange?.(payload.toolId);
        return result;
      },
    });
  }
}
