// The host as the app (and its `--self-test`) runs it: the real dependencies, the layout chosen
// explicitly (dev repo or packaged bundle, layout.ts), Electron's own binary as Node when
// packaged, the state folder's lock, and the worker's extra environment (keys from the app's
// secure settings, the Chromium folder).
import { join } from "node:path";
import type { Advertiser } from "./bonjour.ts";
import { DnsSdAdvertiser } from "./bonjour.ts";
import * as guards from "./guards.ts";
import {
  type ChildLayout,
  chooseLayout,
  electronNodeRuntime,
  type NodeRuntime,
  shellNodeRuntime,
} from "./layout.ts";
import { defaultHostDeps, type HostConfiguration, type HostDeps, LocalHost } from "./local-host.ts";
import { HostLock, realLockDeps } from "./lock.ts";
import { type ProcessLauncher, SpawnLauncher } from "./process.ts";
import type { Cipher } from "./secrets.ts";
import { chromiumEnv } from "./tools.ts";
import { WorkerEnvStore } from "./worker-env.ts";
import * as env from "./environment.ts";

export interface CreateHostInput {
  stateDir: string;
  configuration: () => HostConfiguration;
  cipher: Cipher | null;
  ownerSecret: () => string;
  /** The app's executable (`process.execPath`): Node for the packaged children. */
  executable: string;
  isPackaged: boolean;
  /** `process.resourcesPath` (the packaged host is `<resources>/host`). */
  resourcesPath: string;
  /** `app.getAppPath()` (a dev build finds its repo above it). */
  appPath: string;
  version: string;
  /** `STUDIO_HOST_DIR`: run a staged host (`out/host`) from a dev build. */
  hostDirOverride?: string | undefined;
  readTunnelToken?: () => Promise<string | null>;
  /** Added last to the worker's environment (the self-test turns the AI off with it). */
  workerEnvOverrides?: Record<string, string>;
  /** false: no `.env` import, no stored keys (the self-test's clean worker). */
  useWorkerEnvStore?: boolean;
  launcher?: ProcessLauncher;
  advertiser?: Advertiser;
  deps?: Partial<HostDeps>;
  log?: (message: string) => void;
}

export interface CreatedHost {
  host: LocalHost;
  lock: HostLock;
  workerEnv: WorkerEnvStore;
  /** The layout the next start uses (null: none usable). */
  layout(): ChildLayout | null;
  /** How Node children start for a layout (packaged: this app's binary). */
  runtime(layout: ChildLayout): Promise<NodeRuntime | null>;
  mode: "dev" | "packaged";
}

export function createHost(input: CreateHostInput): CreatedHost {
  const mode = input.isPackaged || input.hostDirOverride ? "packaged" : "dev";
  const layout = (config: HostConfiguration = input.configuration()) =>
    chooseLayout({
      isPackaged: input.isPackaged,
      resourcesPath: input.resourcesPath,
      appPath: input.appPath,
      stateDir: input.stateDir,
      repoSetting: config.repoPath,
      hostDirOverride: input.hostDirOverride,
    });
  const nodeRuntime = (l: ChildLayout): NodeRuntime | null =>
    l.mode === "packaged" ? electronNodeRuntime(input.executable, l.root) : null;
  const lock = new HostLock(
    input.stateDir,
    { pid: process.pid, mode, version: input.version },
    realLockDeps(guards.isAlive),
  );
  const workerEnv = new WorkerEnvStore(input.stateDir, input.cipher);
  const useStore = input.useWorkerEnvStore !== false;

  const host = new LocalHost(
    {
      ...defaultHostDeps({
        stateDir: input.stateDir,
        launcher: input.launcher ?? new SpawnLauncher(),
        advertiser: input.advertiser ?? new DnsSdAdvertiser(),
        cipher: input.cipher,
        ownerSecret: input.ownerSecret,
      }),
      ...(input.readTunnelToken ? { readTunnelToken: input.readTunnelToken } : {}),
      layout,
      nodeRuntime,
      lock,
      workerEnv: (l) => {
        if (useStore && l.mode === "dev" && l.repo) {
          // The repo `.env` → the app's sealed store, when it changed (never logged).
          try {
            const names = workerEnv.syncFromDotEnv(join(l.repo, ".env"));
            if (names) input.log?.(`.env içe aktarıldı: ${names.length} değişken (${names.join(", ")})`);
          } catch (error) {
            input.log?.(`.env içe aktarılamadı: ${(error as Error).message}`);
          }
        }
        return {
          ...(useStore ? workerEnv.env() : {}),
          ...chromiumEnv(l, input.stateDir),
          ...(input.workerEnvOverrides ?? {}),
        };
      },
      ...(input.deps ?? {}),
    },
    input.configuration,
  );

  return {
    host,
    lock,
    workerEnv,
    layout: () => layout(),
    async runtime(l) {
      const packaged = nodeRuntime(l);
      if (packaged) return packaged;
      const node = env.which("node", await env.loginShellPath());
      return node ? shellNodeRuntime(node) : null;
    },
    mode,
  };
}
