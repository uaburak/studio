import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dnsSdArguments, txtRecord } from "../../src/main/host/bonjour.ts";
import {
  baseEnvironment,
  defaultRepoPath,
  expandTilde,
  lanAddresses,
  mergePath,
  parseShellPath,
  tailText,
} from "../../src/main/host/environment.ts";
import {
  accessFailureMessage,
  checkRepoAccess,
  migrationTimeoutMessage,
  normalizedHostname,
  orphanedHelpers,
  parseLsofCwd,
  parsePs,
  protectedFolder,
  tunnelArguments,
  tunnelEnvironment,
} from "../../src/main/host/guards.ts";
import {
  loadOrCreateHostSecrets,
  loadOrCreateInstanceId,
  loadOrCreateOwnerSecret,
  readHostFile,
  removeHostFile,
  writeHostFile,
} from "../../src/main/host/secrets.ts";
import { NoticeLog, Notifier } from "../../src/main/notifications.ts";
import { apiTargetUrl, resolveAppFile } from "../../src/main/protocol-paths.ts";
import {
  applyPatch,
  defaultSettings,
  normalizeSettings,
  SettingsStore,
} from "../../src/main/settings.ts";

describe("environment", () => {
  it("reads the PATH between the markers and appends tool folders", () => {
    expect(parseShellPath("noise\n__STUDIO_PATH__/a:/b__END__more")).toBe("/a:/b");
    expect(parseShellPath("nothing")).toBeNull();
    expect(mergePath("/a:/usr/bin", "/Users/x")).toBe(
      "/a:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("gives children only the basics", () => {
    const env = baseEnvironment(
      "/p",
      { LANG: "tr_TR.UTF-8", USER: "deniz", SECRET: "x", TMPDIR: "/t" },
      "/h",
    );
    expect(env).toEqual({
      PATH: "/p",
      HOME: "/h",
      LANG: "tr_TR.UTF-8",
      USER: "deniz",
      TMPDIR: "/t",
    });
  });

  it("finds the repo above the app and expands ~", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    mkdirSync(join(root, "apps", "desktop", "out"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "");
    writeFileSync(join(root, "apps", "api", "wrangler.jsonc"), "{}");
    expect(defaultRepoPath(join(root, "apps", "desktop", "out"))).toBe(root);
    expect(expandTilde("~/x", "/Users/b")).toBe("/Users/b/x");
  });

  it("lists LAN IPv4 addresses only", () => {
    expect(
      lanAddresses({
        lo0: [
          {
            address: "127.0.0.1",
            family: "IPv4",
            internal: true,
            netmask: "",
            mac: "",
            cidr: null,
          },
        ],
        en0: [
          {
            address: "192.168.1.5",
            family: "IPv4",
            internal: false,
            netmask: "",
            mac: "",
            cidr: null,
          },
          {
            address: "fe80::1",
            family: "IPv6",
            internal: false,
            netmask: "",
            mac: "",
            cidr: null,
            scopeid: 0,
          },
        ],
        en5: [
          {
            address: "169.254.2.2",
            family: "IPv4",
            internal: false,
            netmask: "",
            mac: "",
            cidr: null,
          },
        ],
      }),
    ).toEqual(["192.168.1.5"]);
  });

  it("tails logs without colour codes", () => {
    expect(tailText("a\n\u001B[31mred\u001B[0m\n\nb\nc", 3)).toBe("red\nb\nc");
  });
});

describe("secrets and host.json", () => {
  it("without safeStorage creates 0600 plain secrets once and reuses them", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    const first = loadOrCreateHostSecrets(dir, null);
    expect(first.workerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(first.vaultKey, "base64")).toHaveLength(32);
    expect(loadOrCreateHostSecrets(dir, null)).toEqual(first);
    expect(statSync(join(dir, "worker-token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "vault-key")).mode & 0o777).toBe(0o600);
    const id = loadOrCreateInstanceId(dir);
    expect(loadOrCreateInstanceId(dir)).toBe(id);
  });

  it("keeps a persistent 0600 owner secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    const secret = loadOrCreateOwnerSecret(dir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateOwnerSecret(dir)).toBe(secret);
    expect(statSync(join(dir, "owner-secret")).mode & 0o777).toBe(0o600);
  });

  it("removes host.json only while it names this app", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    writeHostFile(dir, { apiPort: 8790, pid: 77 });
    removeHostFile(dir, 78);
    expect(readHostFile(dir)).not.toBeNull();
    removeHostFile(dir, 77);
    expect(readHostFile(dir)).toBeNull();
    removeHostFile(dir, 77); // no file: no error
  });

  it("writes host.json (lanPort left out when off)", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-"));
    writeHostFile(dir, { apiPort: 8790, lanPort: null, pid: 12 });
    expect(JSON.parse(readFileSync(join(dir, "host.json"), "utf8"))).toEqual({
      apiPort: 8790,
      pid: 12,
    });
    writeFileSync(join(dir, "host.json"), '{"apiPort":8790,"pid":87527,"lanPort":8791}');
    expect(readHostFile(dir)).toEqual({ apiPort: 8790, pid: 87527, lanPort: 8791 });
    writeFileSync(join(dir, "host.json"), "{broken");
    expect(readHostFile(dir)).toBeNull();
  });
});

describe("guards", () => {
  it("names the protected folder and explains denials", () => {
    expect(protectedFolder("/Users/b/Desktop/Code/Studio", "/Users/b")).toBe("Masaüstü Klasörü");
    expect(protectedFolder("/Users/b/Code", "/Users/b")).toBeNull();
    expect(
      accessFailureMessage(
        { kind: "denied", code: "EPERM" },
        "/Users/b/Desktop/S",
        "/p",
        "/Users/b",
      ),
    ).toContain("Masaüstü Klasörü");
    expect(migrationTimeoutMessage(120, "/Users/b/Documents/S", "/Users/b")).toContain(
      "Belgeler Klasörü",
    );
  });

  it("waits for a blocked repo read, says so, and gives up at the limit", async () => {
    let waited = false;
    const outcome = await checkRepoAccess(() => new Promise(() => undefined), {
      noticeAfterMs: 5,
      limitMs: 20,
      onWaiting: () => {
        waited = true;
      },
    });
    expect(waited).toBe(true);
    expect(outcome).toEqual({ kind: "stillWaiting" });
    expect(
      await checkRepoAccess(async () => null, {
        noticeAfterMs: 50,
        limitMs: 100,
        onWaiting: () => undefined,
      }),
    ).toEqual({ kind: "readable" });
  });

  it("builds cloudflared arguments", () => {
    expect(normalizedHostname(" https://social.example.com/ ")).toBe("social.example.com");
    // The token never goes on the command line (G2): only TUNNEL_TOKEN in the environment.
    expect(tunnelArguments("tok", "x", "http://127.0.0.1:8791")).toEqual([
      "tunnel",
      "--no-autoupdate",
      "run",
      "--url",
      "http://127.0.0.1:8791",
    ]);
    expect(tunnelEnvironment(" tok ")).toEqual({ TUNNEL_TOKEN: "tok" });
    expect(tunnelEnvironment(null)).toEqual({});
    expect(tunnelArguments(null, "studio.example.com/", "http://127.0.0.1:1")).toEqual([
      "tunnel",
      "--no-autoupdate",
      "run",
      "--url",
      "http://127.0.0.1:1",
      "studio.example.com",
    ]);
    // No default address: nothing to add when the owner has not typed one.
    expect(normalizedHostname("  ")).toBe("");
  });

  it("finds the dns-sd and cloudflared a crashed app left behind (and nothing else)", () => {
    const ps = [
      "    1     0 /sbin/launchd",
      "  501     1 /usr/bin/dns-sd -R Deniz's Mac _studio._tcp local 8791 name=Deniz api=1",
      "  502  4242 /usr/bin/dns-sd -R Deniz's Mac _studio._tcp local 8791 name=Deniz api=1",
      "  503     1 /usr/bin/dns-sd -B _airplay._tcp",
      "  504     1 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8791",
      "  505   900 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8791",
      "  506     1 /opt/homebrew/bin/cloudflared tunnel login",
      "garbage line",
    ].join("\n");
    const entries = parsePs(ps);
    expect(entries).toHaveLength(7);
    expect(orphanedHelpers(entries)).toEqual({ dnsSd: [501], cloudflared: [504] });
  });

  it("parses lsof cwd output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/b/repo/apps/worker\n")).toBe(
      "/Users/b/repo/apps/worker",
    );
  });
});

describe("Bonjour", () => {
  it("advertises _studio._tcp with the TXT keys phones read", () => {
    const input = { name: "Mac", port: 8791, macId: "id-1", addresses: ["10.0.0.2", "10.0.0.3"] };
    expect(txtRecord(input)).toEqual([
      "name=Mac",
      "api=1",
      "pairing=required",
      "addr=10.0.0.2,10.0.0.3",
      "port=8791",
      "id=id-1",
    ]);
    expect(dnsSdArguments(input).slice(0, 5)).toEqual([
      "-R",
      "Mac",
      "_studio._tcp",
      "local",
      "8791",
    ]);
  });
});

describe("protocol paths", () => {
  it("never serves files outside the renderer folder", () => {
    expect(resolveAppFile("/app/r", "/index.html")).toBe("/app/r/index.html");
    expect(resolveAppFile("/app/r", "/")).toBe("/app/r/index.html");
    expect(resolveAppFile("/app/r", "/%2e%2e/%2e%2e/etc/passwd")).toBe("/app/r/etc/passwd");
  });

  it("forwards /api to the local API", () => {
    expect(apiTargetUrl("studio://app/api/brands?limit=5", 8790)).toBe(
      "http://127.0.0.1:8790/api/brands?limit=5",
    );
    expect(apiTargetUrl("studio://app/assets/x.js", 8790)).toBeNull();
  });
});

describe("settings", () => {
  it("defaults broken values and merges patches", () => {
    const defaults = defaultSettings("/repo");
    const s = normalizeSettings(
      { appearance: "neon", lanEnabled: false, session: { route: "c:1", panelPane: 5 } },
      defaults,
    );
    expect(s.appearance).toBe("system");
    expect(s.lanEnabled).toBe(false);
    expect(s.session.route).toBe("c:1");
    expect(s.session.panelPane).toBe("details");
    const next = applyPatch(s, {
      agent: { conversations: { c1: { model: "opus", effort: "high" } } },
      session: { sidebarPresented: false },
    });
    expect(next.agent.conversations.c1).toEqual({ model: "opus", effort: "high" });
    expect(next.session.route).toBe("c:1");
    expect(next.session.sidebarPresented).toBe(false);
  });

  it("persists to the state folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-"));
    const file = join(dir, "desktop-settings.json");
    const store = new SettingsStore(file, defaultSettings("/repo"));
    store.update({ ownerName: "Deniz" });
    expect(new SettingsStore(file, defaultSettings("/repo")).get().ownerName).toBe("Deniz");
  });
});

describe("notifications", () => {
  it("never posts the same notice twice and respects the switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "notices-"));
    const shown: string[] = [];
    let enabled = true;
    const notifier = new Notifier(
      { isSupported: () => true, show: (n) => shown.push(n.id) },
      new NoticeLog(join(dir, "n.json"), 2),
      () => enabled,
      () => undefined,
    );
    expect(notifier.post({ id: "a", title: "t", body: "b" })).toBe(true);
    expect(notifier.post({ id: "a", title: "t", body: "b" })).toBe(false);
    enabled = false;
    expect(notifier.post({ id: "b", title: "t", body: "b" })).toBe(false);
    expect(shown).toEqual(["a"]);
    expect(new NoticeLog(join(dir, "n.json")).has("a")).toBe(true);
  });
});
