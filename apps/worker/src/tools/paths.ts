// Where Studio's own tools live, resolved the same way as the Mac app (contract tools.ts):
// `STUDIO_TOOLS_DIR` (the host sets it to `<state>/tools`), else
// `~/Library/Application Support/Studio/tools`. `tools/bin` is first on PATH, so Studio's copy of a
// tool wins over the system's; a system copy is still found (and counted as installed) after it.
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathWithTools, studioStateDir, studioToolsDir, toolsBinDir } from "@studio/contract";

export function workerToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.STUDIO_TOOLS_DIR?.trim();
  if (explicit) return explicit;
  return studioToolsDir(studioStateDir(env.HOME || homedir()));
}

export function workerToolsBin(env: NodeJS.ProcessEnv = process.env): string {
  return toolsBinDir(workerToolsDir(env));
}

/** Put Studio's `tools/bin` first on this process's PATH (every child inherits it). */
export function usePathWithTools(env: NodeJS.ProcessEnv = process.env): void {
  env.PATH = pathWithTools(env.PATH ?? "/usr/bin:/bin", workerToolsDir(env));
}

/** Homebrew and the usual user folders (Finder-launched apps get a short PATH). */
export function systemToolDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".studio", "bin"),
  ];
}

export function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * A copy of `names` already on the Mac: PATH then Homebrew / ~/.local/bin, never Studio's own
 * `tools/bin` (that one is "studio", not "system").
 */
export function findSystemExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const bin = path.resolve(workerToolsBin(env));
  const toolsRoot = path.resolve(workerToolsDir(env));
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...systemToolDirs(env)].filter(
    (d) => d && path.resolve(d) !== bin && !path.resolve(d).startsWith(`${toolsRoot}${path.sep}`),
  );
  for (const dir of [...new Set(dirs)]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Studio's own copy of `name` (`tools/bin/<name>`), when it is there and runnable. */
export function managedExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidate = path.join(workerToolsBin(env), name);
  return isExecutableFile(candidate) ? candidate : null;
}
