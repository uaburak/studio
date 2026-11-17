import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvertiseInput, Advertiser } from "../../src/main/host/bonjour.ts";
import {
  buildSpecs,
  type HostConfiguration,
  type HostDeps,
  LocalHost,
  type MacRoutesInput,
} from "../../src/main/host/local-host.ts";
import type { ProcessLauncher, ProcessSpec, RunningProcess } from "../../src/main/host/process.ts";

class Proc implements RunningProcess {
  private done!: (code: number) => void;
  private readonly exited = new Promise<number>((r) => {
    this.done = r;
  });
  constructor(
    readonly pid: number,
    readonly spec: ProcessSpec,
  ) {}
  waitForExit() {
    return this.exited;
  }
  end(code: number) {
    this.done(code);
  }
  async terminate() {
    this.done(143);
  }
}

class Launcher implements ProcessLauncher {
  started: Proc[] = [];
  migrateExit = 0;
  launch(spec: ProcessSpec): RunningProcess {
    const p = new Proc(1000 + this.started.length, spec);
    this.started.push(p);
    if (spec.name === "migrate") queueMicrotask(() => p.end(this.migrateExit));
    return p;
  }
  names() {
    return this.started.map((p) => p.spec.name);
  }
}

class Bonjour implements Advertiser {
  starts: AdvertiseInput[] = [];
  isAdvertising = false;
  start(input: AdvertiseInput) {
    this.starts.push(input);
    this.isAdvertising = true;
  }
  stop() {
    this.isAdvertising = false;
  }
}

const config: HostConfiguration = {
  hostEnabled: true,
  repoPath: "/repo",
  lanEnabled: true,
  remoteControlEnabled: false,
  remoteHostname: "social.example.com",
  preferredAPIPort: 8790,
  preferredLANPort: 8791,
};

function setup(overrides: Partial<HostDeps> = {}, conf: Partial<HostConfiguration> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "studio-host-"));
  writeFileSync(join(stateDir, "instance-id"), "inst-1");
  const launcher = new Launcher();
  const advertiser = new Bonjour();
  const routes: MacRoutesInput[] = [];
  let apiUp = false;
  const deps: HostDeps = {
    stateDir,
    launcher,
    advertiser,
    ownPid: 4242,
    health: vi.fn(async () => (apiUp ? { instance: "inst-1" } : null)),
    isAlive: vi.fn(() => false),
    stopLeftovers: vi.fn(async () => undefined),
    loginShellPath: () => "/usr/bin:/opt/homebrew/bin",
    which: (tool) =>
      tool === "node"
        ? "/opt/homebrew/bin/node"
        : tool === "claude"
          ? "/opt/homebrew/bin/claude"
          : null,
    fileExists: () => true,
    isPortFree: async () => true,
    freePort: async () => 50000,
    lanAddresses: () => ["192.168.1.20"],
    computerName: () => "Burak's MacBook Pro",
    checkRepoAccess: async () => ({ kind: "readable" }),
    readTunnelToken: async () => null,
    publishRoutes: async (_port, r) => {
      routes.push(r);
      return true;
    },
    tail: () => "log tail",
    rotate: () => undefined,
    sleep: async () => {
      apiUp = true;
    },
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
    supervisor: { sleep: async () => undefined },
    networkPollMs: 60_000_000,
    ...overrides,
  };
  const host = new LocalHost(deps, () => ({ ...config, ...conf }));
  return {
    host,
    deps,
    launcher,
    advertiser,
    routes,
    stateDir,
    setApiUp: (v: boolean) => (apiUp = v),
  };
}

const hosts: LocalHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

describe("LocalHost attach rules", () => {
  it("attaches to a running copy whose owner app is alive and answers with our instance id", async () => {
    const ctx = setup({ isAlive: vi.fn(() => true) });
    hosts.push(ctx.host);
    writeFileSync(
      join(ctx.stateDir, "host.json"),
      JSON.stringify({ apiPort: 8795, lanPort: 8791, pid: 777 }),
    );
    ctx.setApiUp(true);
    await ctx.host.start();
    expect(ctx.host.status).toEqual({ kind: "attached" });
    expect(ctx.host.apiPort).toBe(8795);
    expect(ctx.launcher.started).toHaveLength(0);
    expect(ctx.deps.stopLeftovers).not.toHaveBeenCalled();
    expect(ctx.host.ownsChildren).toBe(false);
  });

  it("does not attach to another host's API (different instance id)", async () => {
    const ctx = setup({
      isAlive: vi.fn(() => true),
      health: vi.fn(async () => ({ instance: "someone-else" })),
    });
    hosts.push(ctx.host);
    writeFileSync(join(ctx.stateDir, "host.json"), JSON.stringify({ apiPort: 8790, pid: 777 }));
    await ctx.host.start();
    // The API never answers with our id → the start times out instead of attaching.
    expect(ctx.host.status.kind).toBe("error");
    expect(ctx.launcher.names()).toContain("migrate");
  });

  it("stops leftovers of a crashed owner and starts fresh instead of attaching", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    writeFileSync(join(ctx.stateDir, "host.json"), JSON.stringify({ apiPort: 8790, pid: 777 }));
    ctx.setApiUp(true); // the leftover API still answers — it must not be reused
    await ctx.host.start();
    expect(ctx.deps.stopLeftovers).toHaveBeenCalledWith("/repo");
    expect(ctx.host.status).toEqual({ kind: "running" });
    expect(ctx.launcher.names()).toEqual(["migrate", "api", "gateway", "worker"]);
    const hostFile = JSON.parse(readFileSync(join(ctx.stateDir, "host.json"), "utf8"));
    expect(hostFile).toEqual({ apiPort: 8790, lanPort: 8791, pid: 4242 });
  });

  it("with the host disabled it only attaches", async () => {
    const ctx = setup({}, { hostEnabled: false });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status.kind).toBe("error");
    expect(ctx.launcher.started).toHaveLength(0);
    expect(ctx.deps.stopLeftovers).not.toHaveBeenCalled();
  });
});

describe("LocalHost start", () => {
  it("builds the children's environment and advertises the gateway", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    const byName = Object.fromEntries(ctx.launcher.started.map((p) => [p.spec.name, p.spec]));
    const token = readFileSync(join(ctx.stateDir, "worker-token"), "utf8");
    const vault = readFileSync(join(ctx.stateDir, "vault-key"), "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(ctx.stateDir, "worker-token")).mode & 0o777).toBe(0o600);
    expect(byName.migrate?.args.slice(1, 6)).toEqual([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
    ]);
    expect(byName.migrate?.env.CI).toBe("1");
    expect(byName.api?.env).toMatchObject({
      WORKER_TOKEN: token,
      TOKEN_ENCRYPTION_KEY: vault,
      STUDIO_INSTANCE_ID: "inst-1",
      WRANGLER_SEND_METRICS: "false",
      PATH: "/usr/bin:/opt/homebrew/bin",
    });
    expect(byName.api?.args).toContain("--port");
    expect(byName.api?.args).toContain(join(ctx.stateDir, "api", "state"));
    expect(byName.gateway?.env).toMatchObject({
      STUDIO_GATEWAY_HOST: "0.0.0.0",
      STUDIO_GATEWAY_PORT: "8791",
      STUDIO_API_PORT: "8790",
    });
    expect(byName.worker?.env).toMatchObject({
      STUDIO_HUB_URL: "ws://127.0.0.1:8790/api/hub",
      STUDIO_WORKER_TOKEN: token,
      STUDIO_CLAUDE_BIN: "/opt/homebrew/bin/claude",
    });
    expect(byName.worker?.env.STUDIO_GEMINI_BIN).toBeUndefined();
    expect(byName.worker?.args).toEqual([
      "--env-file-if-exists=/repo/.env",
      "--import",
      "tsx",
      "src/main.ts",
    ]);
    expect(byName.worker?.cwd).toBe("/repo/apps/worker");
    expect(ctx.advertiser.starts[0]).toEqual({
      name: "Burak's MacBook Pro",
      port: 8791,
      macId: "inst-1",
      addresses: ["192.168.1.20"],
    });
    expect(ctx.host.ownsChildren).toBe(true);
  });

  it("reuses the shared secrets of the AppKit app", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    writeFileSync(join(ctx.stateDir, "worker-token"), "a".repeat(64));
    writeFileSync(join(ctx.stateDir, "vault-key"), "b".repeat(44));
    await ctx.host.start();
    const api = ctx.launcher.started.find((p) => p.spec.name === "api");
    expect(api?.spec.env.WORKER_TOKEN).toBe("a".repeat(64));
    expect(api?.spec.env.TOKEN_ENCRYPTION_KEY).toBe("b".repeat(44));
  });

  it("falls back to a free port when the preferred one is taken", async () => {
    const ctx = setup({ isPortFree: async (port) => port !== 8790 });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.apiPort).toBe(50000);
  });

  it("publishes where phones can reach the Mac", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.routes[0]).toEqual({
      macName: "Burak's MacBook Pro",
      macId: "inst-1",
      lanAddresses: ["192.168.1.20"],
      lanPort: 8791,
      bonjourName: "Burak's MacBook Pro",
      tunnelUrl: null,
    });
  });

  it("fails clearly when node is missing or the repo is not installed", async () => {
    const noNode = setup({ which: () => null });
    hosts.push(noNode.host);
    await noNode.host.start();
    expect(noNode.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("node bulunamadı"),
    });

    const noRepo = setup({ fileExists: () => false });
    hosts.push(noRepo.host);
    await noRepo.host.start();
    expect(noRepo.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("pnpm install"),
    });
  });

  it("reports a failed migration with its log", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    ctx.launcher.migrateExit = 1;
    await ctx.host.start();
    expect(ctx.host.status).toEqual({
      kind: "error",
      message: "Veritabanı güncellemesi başarısız (çıkış kodu 1).",
      log: "log tail",
    });
    expect(ctx.launcher.names()).toEqual(["migrate"]);
  });

  it("explains a denied repo folder (macOS privacy)", async () => {
    const ctx = setup({ checkRepoAccess: async () => ({ kind: "denied", code: "EPERM" }) });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Gizlilik ve Güvenlik"),
    });
  });

  it("stop ends the children: worker before gateway before API", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    await ctx.host.stop();
    expect(ctx.host.status).toEqual({ kind: "stopped" });
    expect(ctx.host.ownsChildren).toBe(false);
    expect(ctx.advertiser.isAdvertising).toBe(false);
  });
});

describe("buildSpecs", () => {
  it("runs the gateway on loopback for the tunnel when LAN access is off", () => {
    const specs = buildSpecs({
      node: "/n",
      repo: "/r",
      stateDir: "/s",
      base: { PATH: "/bin" },
      token: "t",
      vaultKey: "v",
      instance: "i",
      apiPort: 9000,
      claude: null,
      gemini: "/g",
    });
    expect(specs.gateway("127.0.0.1", 9100).env).toMatchObject({
      STUDIO_GATEWAY_HOST: "127.0.0.1",
      STUDIO_GATEWAY_PORT: "9100",
      STUDIO_API_PORT: "9000",
    });
    expect(specs.worker.env.STUDIO_GEMINI_BIN).toBe("/g");
    expect(specs.api.args).toContain("--show-interactive-dev-session=false");
    expect(specs.required).toContain("/r/apps/api/node_modules/wrangler/bin/wrangler.js");
  });
});
