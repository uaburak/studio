import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvertiseInput, Advertiser } from "../../src/main/host/bonjour.ts";
import { electronNodeRuntime, packagedLayout } from "../../src/main/host/layout.ts";
import { HostLock, type LockDeps } from "../../src/main/host/lock.ts";
import {
  buildSpecs,
  FOREIGN_HOST_MESSAGE,
  type HostConfiguration,
  type HostDeps,
  LocalHost,
  type MacRoutesInput,
} from "../../src/main/host/local-host.ts";
import type { ProcessLauncher, ProcessSpec, RunningProcess } from "../../src/main/host/process.ts";
import type { Cipher } from "../../src/main/host/secrets.ts";

/** A reversible stand-in for safeStorage. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`sealed:${text}`, "utf8"),
  decrypt: (data) => {
    const text = data.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not sealed");
    return text.slice("sealed:".length);
  },
};

const OWNER = "owner-secret-0123456789abcdef0123456789abcdef";

/** The sealed worker token and vault key, opened. */
function sealed(stateDir: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(stateDir, "host-secrets.json"), "utf8")) as Record<
    string,
    string
  >;
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, cipher.decrypt(Buffer.from(v, "base64"))]),
  );
}

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
    cipher,
    ownerSecret: () => OWNER,
    health: vi.fn(async () => (apiUp ? { instance: "inst-1" } : null)),
    ownerCheck: vi.fn(async () => true),
    isAlive: vi.fn(() => false),
    stopLeftovers: vi.fn(async () => undefined),
    snapshotDatabase: vi.fn(() => undefined),
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
    expect(ctx.deps.stopLeftovers).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "dev", root: "/repo" }),
      ctx.stateDir,
    );
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
    // G10: the worker token and vault key are sealed with safeStorage, never plain files.
    const keys = sealed(ctx.stateDir);
    const token = keys["worker-token"] ?? "";
    const vault = keys["vault-key"] ?? "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(vault, "base64")).toHaveLength(32);
    expect(statSync(join(ctx.stateDir, "host-secrets.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(ctx.stateDir, "worker-token"))).toBe(false);
    expect(existsSync(join(ctx.stateDir, "vault-key"))).toBe(false);
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
      STUDIO_OWNER_SECRET: OWNER,
      STUDIO_INSTANCE_ID: "inst-1",
      WRANGLER_SEND_METRICS: "false",
      PATH: "/usr/bin:/opt/homebrew/bin",
    });
    // Secrets only travel in the environment, never on a command line (G1, G2).
    const commandLines = ctx.launcher.started.map((p) => p.spec.args.join(" ")).join("\n");
    for (const secret of [token, vault, OWNER]) expect(commandLines).not.toContain(secret);
    expect(byName.worker?.env.STUDIO_OWNER_SECRET).toBeUndefined();
    expect(byName.gateway?.env.STUDIO_OWNER_SECRET).toBeUndefined();
    expect(ctx.deps.snapshotDatabase).toHaveBeenCalledWith(ctx.stateDir);
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

  it("moves the AppKit app's plain secrets into safeStorage once", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    writeFileSync(join(ctx.stateDir, "worker-token"), "a".repeat(64));
    writeFileSync(join(ctx.stateDir, "vault-key"), "b".repeat(44));
    await ctx.host.start();
    const api = ctx.launcher.started.find((p) => p.spec.name === "api");
    expect(api?.spec.env.WORKER_TOKEN).toBe("a".repeat(64));
    expect(api?.spec.env.TOKEN_ENCRYPTION_KEY).toBe("b".repeat(44));
    expect(sealed(ctx.stateDir)).toEqual({
      "worker-token": "a".repeat(64),
      "vault-key": "b".repeat(44),
    });
    expect(existsSync(join(ctx.stateDir, "worker-token"))).toBe(false);
    expect(existsSync(join(ctx.stateDir, "vault-key"))).toBe(false);
  });

  it("refuses to start when the sealed vault key cannot be opened (never makes a new one)", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    writeFileSync(
      join(ctx.stateDir, "host-secrets.json"),
      JSON.stringify({ "vault-key": Buffer.from("garbage").toString("base64") }),
    );
    await ctx.host.start();
    expect(ctx.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("çözülemedi"),
    });
    expect(ctx.launcher.started).toHaveLength(0);
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
      // `/api/health` reads the tunnel's state from here (P9).
      tunnel: { state: "off", detail: "Kapalı." },
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

  it("stop ends the children: worker before gateway before API, and removes host.json", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(existsSync(join(ctx.stateDir, "host.json"))).toBe(true);
    await ctx.host.stop();
    expect(ctx.host.status).toEqual({ kind: "stopped" });
    expect(ctx.host.ownsChildren).toBe(false);
    expect(ctx.advertiser.isAdvertising).toBe(false);
    expect(existsSync(join(ctx.stateDir, "host.json"))).toBe(false);
  });

  it("does not attach to a host that refuses this app's owner secret", async () => {
    const ctx = setup({ isAlive: vi.fn(() => true), ownerCheck: vi.fn(async () => false) });
    hosts.push(ctx.host);
    writeFileSync(join(ctx.stateDir, "host.json"), JSON.stringify({ apiPort: 8795, pid: 777 }));
    ctx.setApiUp(true);
    await ctx.host.start();
    expect(ctx.host.status).toMatchObject({ kind: "error", message: FOREIGN_HOST_MESSAGE });
    expect(ctx.launcher.started).toHaveLength(0);
    // The other app's host.json stays.
    expect(existsSync(join(ctx.stateDir, "host.json"))).toBe(true);
  });

  it("turns an unexpected failure into an error that can be retried", async () => {
    let calls = 0;
    const ctx = setup({
      computerName: () => {
        calls += 1;
        if (calls === 1) throw new Error("scutil exploded");
        return "Mac";
      },
    });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("scutil exploded"),
    });
    await ctx.host.restart();
    expect(ctx.host.status).toEqual({ kind: "running" });
  });

  it("copies the database before migrating, and does not migrate when the copy fails", async () => {
    const order: string[] = [];
    const ctx = setup({
      snapshotDatabase: vi.fn(() => {
        order.push("snapshot");
        throw new Error("disk full");
      }),
    });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(order).toEqual(["snapshot"]);
    expect(ctx.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("disk full"),
    });
    expect(ctx.launcher.names()).toEqual([]);
  });

  it("never shows a secret in what it sends to the window", async () => {
    const ctx = setup({
      tail: () => `boom WORKER_TOKEN=abc ${OWNER} --token eyJhIjoiMTIzNDU2Nzg5MCJ9`,
    });
    hosts.push(ctx.host);
    ctx.launcher.migrateExit = 1;
    await ctx.host.start();
    const shown = JSON.stringify(ctx.host.snapshot());
    expect(shown).not.toContain(OWNER);
    expect(shown).not.toContain("eyJhIjoiMTIzNDU2Nzg5MCJ9");
    expect(shown).not.toContain("WORKER_TOKEN=abc");
    expect(shown).toContain("***");
  });

  it("advertises again when dns-sd went away (sleep, mDNSResponder restart)", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.advertiser.starts).toHaveLength(1);
    await ctx.host.networkChanged();
    expect(ctx.advertiser.starts).toHaveLength(1); // still advertising, same addresses
    ctx.advertiser.isAdvertising = false; // dns-sd exited
    await ctx.host.networkChanged();
    expect(ctx.advertiser.starts).toHaveLength(2);
    expect(ctx.advertiser.isAdvertising).toBe(true);
    // A new Wi-Fi: advertise the new address and tell the phones.
    ctx.deps.lanAddresses = () => ["10.0.0.7"];
    await ctx.host.networkChanged();
    expect(ctx.advertiser.starts).toHaveLength(3);
    expect(ctx.advertiser.starts[2]?.addresses).toEqual(["10.0.0.7"]);
    expect(ctx.routes.at(-1)?.lanAddresses).toEqual(["10.0.0.7"]);
  });

  it("does not restart dns-sd on every check when publishing the routes fails", async () => {
    const ctx = setup({ publishRoutes: async () => false });
    hosts.push(ctx.host);
    await ctx.host.start();
    for (let i = 0; i < 3; i++) await ctx.host.networkChanged();
    expect(ctx.advertiser.starts).toHaveLength(1);
  });

  it("refuses backups while attached; otherwise pauses the children and starts again", async () => {
    const attached = setup({ isAlive: vi.fn(() => true) });
    hosts.push(attached.host);
    writeFileSync(
      join(attached.stateDir, "host.json"),
      JSON.stringify({ apiPort: 8795, pid: 777 }),
    );
    attached.setApiUp(true);
    await attached.host.start();
    await expect(attached.host.withStopped("x", async () => 1)).rejects.toThrow("başka bir Studio");
    // Its attach monitor polls with the instant test sleep: stop it before waiting on timers.
    await attached.host.stop();

    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    const seen: string[] = [];
    const result = await ctx.host.withStopped("Yedekleniyor", async () => {
      seen.push(ctx.host.status.kind, String(ctx.host.ownsChildren));
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(["starting", "false"]);
    await new Promise((r) => setTimeout(r, 0));
    await ctx.host.start();
    expect(ctx.host.status).toEqual({ kind: "running" });
    expect(ctx.launcher.names().filter((n) => n === "api")).toHaveLength(2);
  });
});

describe("Remote Control tunnel", () => {
  const remote = { remoteControlEnabled: true };
  const withCloudflared = (overrides: Partial<HostDeps> = {}) =>
    setup(
      {
        which: (tool) =>
          tool === "node" ? "/n" : tool === "cloudflared" ? "/opt/homebrew/bin/cloudflared" : null,
        readTunnelToken: async () => "eyJhIjoidHVubmVsLXRva2VuLXZhbHVlIn0",
        ...overrides,
      },
      remote,
    );

  it("passes the token only in the environment", async () => {
    const ctx = withCloudflared();
    hosts.push(ctx.host);
    await ctx.host.start();
    const tunnel = ctx.launcher.started.find((p) => p.spec.name === "tunnel");
    expect(tunnel?.spec.args).not.toContain("--token");
    expect(tunnel?.spec.args.join(" ")).not.toContain("eyJhIjoidHVubmVsLXRva2VuLXZhbHVlIn0");
    expect(tunnel?.spec.env.TUNNEL_TOKEN).toBe("eyJhIjoidHVubmVsLXRva2VuLXZhbHVlIn0");
  });

  it("a failing tunnel leaves the rest of the host running", async () => {
    const ctx = withCloudflared();
    hosts.push(ctx.host);
    ctx.deps.supervisor = { sleep: async () => undefined, policy: { maxQuickFailures: 0 } };
    await ctx.host.start();
    const tunnel = ctx.launcher.started.find((p) => p.spec.name === "tunnel");
    tunnel?.end(1);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.host.snapshot().services.tunnel?.kind).toBe("failed");
    expect(ctx.host.status).toEqual({ kind: "running" });
    expect(ctx.host.tunnelNote).toContain("tüneli durdu");
  });

  it("a new token restarts only the tunnel", async () => {
    const ctx = withCloudflared();
    hosts.push(ctx.host);
    await ctx.host.start();
    const before = ctx.launcher.names();
    await ctx.host.restartTunnel();
    const after = ctx.launcher.names().slice(before.length);
    expect(after).toEqual(["tunnel"]);
    expect(ctx.host.status).toEqual({ kind: "running" });
    const workers = ctx.launcher.started.filter((p) => p.spec.name === "worker");
    expect(workers).toHaveLength(1);
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
      ownerSecret: "o",
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
    expect(specs.api.env.STUDIO_OWNER_SECRET).toBe("o");
    expect(specs.api.args).toContain("--show-interactive-dev-session=false");
    expect(specs.required).toContain("/r/apps/api/node_modules/wrangler/bin/wrangler.js");
  });
});

describe("LocalHost start and quit (A11)", () => {
  it("reads the login PATH and the Mac's name in the background", async () => {
    const ctx = setup({
      loginShellPath: async () => "/slow/bin:/usr/bin",
      computerName: async () => "Async Mac",
      which: (tool, path) =>
        tool === "node" && path.startsWith("/slow") ? "/slow/bin/node" : null,
    });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status).toEqual({ kind: "running" });
    expect(ctx.launcher.started[0]?.spec.executable).toBe("/slow/bin/node");
    expect(ctx.routes.at(-1)?.macName).toBe("Async Mac");
  });

  it("hides wrangler's banner (no npm update check on every start)", () => {
    const specs = buildSpecs({
      node: "/n",
      repo: "/r",
      stateDir: "/s",
      base: { PATH: "/p" },
      token: "t",
      vaultKey: "v",
      ownerSecret: OWNER,
      instance: "i",
      apiPort: 8790,
      claude: null,
      gemini: null,
    });
    expect(specs.api.env.WRANGLER_HIDE_BANNER).toBe("true");
    expect(specs.migrate.env.WRANGLER_HIDE_BANNER).toBe("true");
  });

  it("stops every service at once with one grace period, saying “Kapatılıyor…”", async () => {
    const ctx = setup();
    hosts.push(ctx.host);
    await ctx.host.start();
    const running = ctx.launcher.started.filter((p) => p.spec.name !== "migrate");
    const asked: { name: string; grace: number }[] = [];
    const finish: (() => void)[] = [];
    for (const p of running) {
      p.terminate = (grace?: number) => {
        asked.push({ name: p.spec.name, grace: grace ?? -1 });
        return new Promise<void>((resolve) => {
          finish.push(() => {
            p.end(143);
            resolve();
          });
        });
      };
    }
    const messages: string[] = [];
    ctx.host.onChange((s) => {
      if (s.status.kind === "starting") messages.push(s.status.message);
    });
    const stopping = ctx.host.stop({ graceMs: 5_000, message: "Kapatılıyor…" });
    await new Promise((r) => setTimeout(r, 0));
    // All asked before any finished: not one after another.
    expect(asked.map((a) => a.name).sort()).toEqual(["api", "gateway", "worker"]);
    expect(asked.every((a) => a.grace === 5_000)).toBe(true);
    expect(messages).toContain("Kapatılıyor…");
    for (const f of finish) f();
    await stopping;
    expect(ctx.host.status).toEqual({ kind: "stopped" });
  });

  it("runs the packaged host with the app's own binary as Node (S3)", async () => {
    const hostDir = mkdtempSync(join(tmpdir(), "studio-app-host-"));
    mkdirSync(join(hostDir, "api"), { recursive: true });
    writeFileSync(
      join(hostDir, "api", "wrangler.json"),
      JSON.stringify({
        name: "studio-api",
        main: "index.js",
        d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      }),
    );
    const app = "/Applications/Studio.app/Contents/MacOS/Studio";
    const ctx = setup({
      layout: () => packagedLayout(hostDir, ctxState.dir),
      nodeRuntime: (l) => electronNodeRuntime(app, l.root),
      workerEnv: () => ({ GEMINI_API_KEY: "gemini-key-0123456789", STUDIO_HUB_URL: "ws://x" }),
      // Node from the login PATH must not be needed.
      which: () => null,
    });
    const ctxState = { dir: ctx.stateDir };
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status).toEqual({ kind: "running" });
    const byName = Object.fromEntries(ctx.launcher.started.map((p) => [p.spec.name, p.spec]));
    const shim = `--require=${join(hostDir, "bin", "node-shim.cjs")}`;
    const config = join(ctx.stateDir, "runtime", "api", "wrangler.json");
    for (const name of ["migrate", "api", "gateway", "worker"]) {
      expect(byName[name]?.executable).toBe(app);
      expect(byName[name]?.args[0]).toBe(shim);
      expect(byName[name]?.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
    expect(byName.migrate?.args[1]).toBe(
      join(hostDir, "node_modules", "wrangler", "bin", "wrangler.js"),
    );
    expect(byName.migrate?.args.slice(-2)).toEqual(["--config", config]);
    expect(byName.api?.args.slice(-2)).toEqual(["--config", config]);
    expect(byName.api?.cwd).toBe(join(ctx.stateDir, "runtime", "api"));
    // wrangler's config is written in the state folder, its paths pointing into the app.
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.main).toBe(join(hostDir, "api", "index.js"));
    expect(written.no_bundle).toBe(true);
    expect(written.d1_databases[0].migrations_dir).toBe(join(hostDir, "api", "migrations"));
    // The worker: the bundle, no repo `.env`, skills from the app, keys from the app's store;
    // the host's own variables win over the store's.
    expect(byName.worker?.args).toEqual([shim, "--enable-source-maps", join(hostDir, "worker", "main.js")]);
    expect(byName.worker?.args.join(" ")).not.toContain(".env");
    expect(byName.worker?.env.STUDIO_SKILLS_DIR).toBe(join(hostDir, "agent", "skills"));
    expect(byName.worker?.env.GEMINI_API_KEY).toBe("gemini-key-0123456789");
    expect(byName.worker?.env.STUDIO_HUB_URL).toBe("ws://127.0.0.1:8790/api/hub");
    expect(byName.worker?.cwd).toBe(join(ctx.stateDir, "worker"));
    // Keys never show up in what the app displays.
    expect(ctx.host.lastLines("worker")).not.toContain("gemini-key-0123456789");
  });

  it("says what is missing when the app's host files are not there", async () => {
    const ctx = setup({
      layout: () => packagedLayout("/nowhere/host", "/tmp/state"),
      nodeRuntime: (l) => electronNodeRuntime("/app", l.root),
      fileExists: () => false,
    });
    hosts.push(ctx.host);
    await ctx.host.start();
    expect(ctx.host.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Studio uygulamasının bir dosyası eksik"),
    });
  });

  it("keeps the children's logs under their limit while they run", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const rotateRunning = vi.fn();
      const ctx = setup({ rotateRunning, logPollMs: 1_000 });
      hosts.push(ctx.host);
      await ctx.host.start();
      vi.advanceTimersByTime(1_000);
      expect(rotateRunning).toHaveBeenCalledWith(join(ctx.stateDir, "logs", "api.log"));
      expect(rotateRunning).toHaveBeenCalledWith(join(ctx.stateDir, "logs", "worker.log"));
      await ctx.host.stop();
      rotateRunning.mockClear();
      vi.advanceTimersByTime(5_000);
      expect(rotateRunning).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LocalHost: one host per state folder (P9)", () => {
  const lockDeps = (alive: Set<number>): LockDeps => ({
    isAlive: (pid) => alive.has(pid),
    processStartedAt: () => null,
    now: Date.now,
  });
  const lockFile = (dir: string) => join(dir, "host.lock");
  const holder = (pid: number, mode: string) =>
    JSON.stringify({ pid, startedAt: null, mode, version: "1", host: "mac", acquiredAt: "" });

  it("takes the lock before touching the database and gives it back on stop", async () => {
    const ctx = setup();
    const lock = new HostLock(
      ctx.stateDir,
      { pid: 4242, mode: "dev", version: "1" },
      lockDeps(new Set([4242])),
    );
    const withLock = new LocalHost({ ...ctx.deps, lock }, () => config);
    hosts.push(withLock);
    await withLock.start();
    expect(withLock.status).toEqual({ kind: "running" });
    expect(JSON.parse(readFileSync(lockFile(ctx.stateDir), "utf8")).pid).toBe(4242);
    await withLock.stop();
    expect(existsSync(lockFile(ctx.stateDir))).toBe(false);
  });

  it("refuses clearly while another live app holds the folder", async () => {
    const ctx = setup();
    writeFileSync(lockFile(ctx.stateDir), holder(777, "packaged"));
    const lock = new HostLock(
      ctx.stateDir,
      { pid: 4242, mode: "dev", version: "1" },
      lockDeps(new Set([777, 4242])),
    );
    const second = new LocalHost({ ...ctx.deps, lock }, () => config);
    hosts.push(second);
    await second.start();
    expect(second.status).toMatchObject({
      kind: "error",
      message: expect.stringContaining("başka bir Studio sunucusu kullanıyor"),
    });
    expect(ctx.launcher.started).toHaveLength(0);
    expect(ctx.deps.snapshotDatabase).not.toHaveBeenCalled();
    // The other app's lock is left alone.
    expect(JSON.parse(readFileSync(lockFile(ctx.stateDir), "utf8")).pid).toBe(777);
  });

  it("takes over the lock of an app that is gone", async () => {
    const ctx = setup();
    writeFileSync(lockFile(ctx.stateDir), holder(777, "dev"));
    const lock = new HostLock(
      ctx.stateDir,
      { pid: 4242, mode: "dev", version: "1" },
      lockDeps(new Set([4242])),
    );
    const host = new LocalHost({ ...ctx.deps, lock }, () => config);
    hosts.push(host);
    await host.start();
    expect(host.status).toEqual({ kind: "running" });
    expect(JSON.parse(readFileSync(lockFile(ctx.stateDir), "utf8")).pid).toBe(4242);
  });
});
