// Where the host's children come from (S3, P1). Chosen once, explicitly:
//
// - dev: the repo checkout this build runs from (`electron-vite dev` / `preview`): wrangler from
//   `apps/api/node_modules`, the worker from its TypeScript sources with tsx, Node from the
//   login shell's PATH. Exactly how Studio ran before it was packaged.
// - packaged: `Studio.app/Contents/Resources/host` (scripts/build-host.mjs): the API's built
//   Worker bundle + migrations run by the bundled wrangler, the bundled gateway script and the
//   worker compiled to plain JS. Node is Electron's own binary in Node mode
//   (`ELECTRON_RUN_AS_NODE=1`), so the Mac needs no Node, pnpm or repo. wrangler writes its
//   temp files next to its config, so the config lives in the state folder
//   (`runtime/api/wrangler.json`), never inside the signed app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { leftoverPatterns } from "./guards.ts";

export type HostMode = "dev" | "packaged";

/** How a Node child is started. */
export interface NodeRuntime {
  /** dev: the login shell's `node`; packaged: the app's own executable. */
  executable: string;
  /** Arguments before the script (packaged: the shim that hides Electron from libraries). */
  args: string[];
  /** Added to the child's environment (packaged: `ELECTRON_RUN_AS_NODE=1`). */
  env: Record<string, string>;
}

export interface ChildLayout {
  mode: HostMode;
  /** dev: the repo checkout; packaged: `Contents/Resources/host`. */
  root: string;
  /** dev only: the repo checkout. */
  repo: string | null;
  /** Working folder of `wrangler` (migrations and the API). */
  apiCwd: string;
  wrangler: string;
  /** Extra wrangler arguments before the command's own (packaged: `--config <file>`). */
  wranglerArgs: string[];
  gatewayScript: string;
  workerCwd: string;
  /** The worker's arguments after the runtime's own. */
  workerArgs: string[];
  /** `STUDIO_SKILLS_DIR` (null: the worker finds the repo's `agent/skills` itself). */
  skillsDir: string | null;
  /** Files that must exist before anything starts. */
  required: string[];
  /** A file read first, so a macOS privacy prompt is noticed (repo in ~/Desktop). */
  probe: string;
  /** `pkill -f` patterns that match only this layout's API and gateway processes. */
  leftoverPatterns: string[];
  /** The worker's process: `pgrep -f` pattern and the working folder it must have. */
  workerLeftover: { pattern: string; cwd: string };
  /** Writes what the children need in the state folder before they start. */
  prepare(stateDir: string): void;
  /** Says what is missing, in Turkish, when a required file is not there. */
  missingMessage(file: string): string;
}

/** The checkout a dev build runs from: walks up to `pnpm-workspace.yaml` + `apps/api`. */
export function findRepo(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "pnpm-workspace.yaml")) &&
      existsSync(join(dir, "apps", "api", "wrangler.jsonc"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function devLayout(repo: string): ChildLayout {
  const apiDir = join(repo, "apps", "api");
  const workerDir = join(repo, "apps", "worker");
  const wrangler = join(apiDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const gatewayScript = join(apiDir, "scripts", "lan-gateway.mjs");
  return {
    mode: "dev",
    root: repo,
    repo,
    apiCwd: apiDir,
    wrangler,
    wranglerArgs: [],
    gatewayScript,
    workerCwd: workerDir,
    // Node loads the repo `.env` itself; the app only imports its keys once (worker-env.ts).
    workerArgs: [`--env-file-if-exists=${join(repo, ".env")}`, "--import", "tsx", "src/main.ts"],
    skillsDir: null,
    required: [
      wrangler,
      gatewayScript,
      join(workerDir, "node_modules", "tsx"),
      join(workerDir, "src", "main.ts"),
    ],
    probe: join(apiDir, "package.json"),
    leftoverPatterns: leftoverPatterns(repo),
    workerLeftover: { pattern: "tsx src/main.ts", cwd: workerDir },
    prepare: () => undefined,
    missingMessage: (file) =>
      `Depo klasörü eksik ya da \`pnpm install\` yapılmamış: ${file} yok. Ayarlar → Gelişmiş → Depo klasörü.`,
  };
}

/** The API's runtime folder in the state folder (wrangler's config and temp files). */
export function apiRuntimeDir(stateDir: string): string {
  return join(stateDir, "runtime", "api");
}

/**
 * The bundled `api/wrangler.json` with its paths made absolute (the bundle and migrations stay in
 * the app; wrangler's `.wrangler/tmp` goes next to the written config, in the state folder).
 */
export function runtimeApiConfig(
  template: Record<string, unknown>,
  hostDir: string,
): Record<string, unknown> {
  const apiDir = join(hostDir, "api");
  const abs = (value: unknown, fallback: string) =>
    typeof value === "string" && value
      ? isAbsolute(value)
        ? value
        : resolve(apiDir, value)
      : fallback;
  const config: Record<string, unknown> = { ...template };
  config.main = abs(template.main, join(apiDir, "index.js"));
  config.no_bundle = true;
  config.send_metrics = false;
  if (Array.isArray(template.d1_databases)) {
    config.d1_databases = template.d1_databases.map((db) =>
      db && typeof db === "object"
        ? {
            ...(db as Record<string, unknown>),
            migrations_dir: abs(
              (db as Record<string, unknown>).migrations_dir,
              join(apiDir, "migrations"),
            ),
          }
        : db,
    );
  }
  return config;
}

export function packagedLayout(hostDir: string, stateDir: string): ChildLayout {
  const wrangler = join(hostDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const gatewayScript = join(hostDir, "gateway", "lan-gateway.mjs");
  const workerMain = join(hostDir, "worker", "main.js");
  const runtime = apiRuntimeDir(stateDir);
  const config = join(runtime, "wrangler.json");
  return {
    mode: "packaged",
    root: hostDir,
    repo: null,
    apiCwd: runtime,
    wrangler,
    wranglerArgs: ["--config", config],
    gatewayScript,
    workerCwd: join(stateDir, "worker"),
    workerArgs: ["--enable-source-maps", workerMain],
    skillsDir: join(hostDir, "agent", "skills"),
    required: [
      wrangler,
      gatewayScript,
      workerMain,
      join(hostDir, "api", "index.js"),
      join(hostDir, "api", "wrangler.json"),
      join(hostDir, "bin", "node-shim.cjs"),
    ],
    probe: join(hostDir, "manifest.json"),
    leftoverPatterns: [`${hostDir}/node_modules/wrangler`, gatewayScript],
    workerLeftover: { pattern: workerMain, cwd: join(stateDir, "worker") },
    prepare(dir) {
      const target = apiRuntimeDir(dir);
      mkdirSync(target, { recursive: true });
      const template = JSON.parse(
        readFileSync(join(hostDir, "api", "wrangler.json"), "utf8"),
      ) as Record<string, unknown>;
      const body = `${JSON.stringify(runtimeApiConfig(template, hostDir), null, 2)}\n`;
      const file = join(target, "wrangler.json");
      let current = "";
      try {
        current = readFileSync(file, "utf8");
      } catch {
        // first start
      }
      if (current !== body) writeFileSync(file, body);
    },
    missingMessage: (file) =>
      `Studio uygulamasının bir dosyası eksik (${file}). Uygulamayı yeniden indirip kur.`,
  };
}

/** Electron's own binary as Node (packaged): the shim first, `ELECTRON_RUN_AS_NODE=1`. */
export function electronNodeRuntime(executable: string, hostDir: string): NodeRuntime {
  return {
    executable,
    args: [`--require=${join(hostDir, "bin", "node-shim.cjs")}`],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** The login shell's `node` (dev). */
export function shellNodeRuntime(node: string): NodeRuntime {
  return { executable: node, args: [], env: {} };
}

/**
 * Which layout this app uses: the packaged one when it runs from a bundle (or when told to with
 * `STUDIO_HOST_DIR`, e.g. a dev build trying the staged `out/host`), else the repo it was built
 * from. Never a guessed path: without either, null (the host then says what is wrong).
 */
export function chooseLayout(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  stateDir: string;
  /** Settings → Gelişmiş → Depo klasörü (dev only); "" = the checkout the build runs from. */
  repoSetting?: string;
  hostDirOverride?: string | undefined;
}): ChildLayout | null {
  if (input.hostDirOverride) return packagedLayout(input.hostDirOverride, input.stateDir);
  if (input.isPackaged) return packagedLayout(join(input.resourcesPath, "host"), input.stateDir);
  const repo = input.repoSetting?.trim() || findRepo(input.appPath);
  return repo ? devLayout(repo) : null;
}
