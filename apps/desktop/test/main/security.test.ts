import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LaunchError, logHeader, SpawnLauncher } from "../../src/main/host/process.ts";
import { MASK, Redactor, redactSecrets } from "../../src/main/host/redact.ts";
import {
  type Cipher,
  HostSecretsError,
  loadOrCreateHostSecrets,
  writeHostSecrets,
} from "../../src/main/host/secrets.ts";
import { permissionAllowed } from "../../src/main/permissions.ts";
import { needsOwnerHeader, originOf } from "../../src/main/protocol-paths.ts";

const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`sealed:${text}`, "utf8"),
  decrypt: (data) => {
    const text = data.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not sealed");
    return text.slice("sealed:".length);
  },
};

describe("redaction (G2)", () => {
  it("masks known values and secret-looking patterns", () => {
    const text = [
      "cloudflared tunnel run --token eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ== --url http://x",
      "cloudflared --token=abc12345xyz run",
      "TUNNEL_TOKEN=supersecretvalue WORKER_TOKEN='quoted value' PATH=/usr/bin",
      "Authorization: Bearer sdt_abcdefghijklmnop",
      "X-Studio-Owner: 0123456789abcdef",
      "device sdt_ZYXWVUTSRQPONMLK used",
      "my-vault-key-0123456789abcdef appears here",
    ].join("\n");
    const out = redactSecrets(text, ["my-vault-key-0123456789abcdef", "short"]);
    for (const secret of [
      "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ",
      "abc12345xyz",
      "supersecretvalue",
      "quoted value",
      "sdt_abcdefghijklmnop",
      "0123456789abcdef",
      "ZYXWVUTSRQPONMLK",
      "my-vault-key-0123456789abcdef",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("PATH=/usr/bin");
    expect(out).toContain("--url http://x");
    expect(out).toContain(MASK);
  });

  it("leaves ordinary text alone and ignores short 'secrets'", () => {
    const text = "API 120 sn içinde yanıt vermedi. (çıkış kodu 1) port 8790";
    expect(redactSecrets(text, ["1", "port"])).toBe(text);
  });

  it("a redactor remembers the host's secrets", () => {
    const r = new Redactor();
    r.add("worker-token-0123456789abcdef", null, undefined, "tiny");
    expect(r.redact("x worker-token-0123456789abcdef y tiny")).toBe(`x ${MASK} y tiny`);
    expect(r.redact("")).toBe("");
  });

  it("never writes a token into a child's log header", () => {
    const header = logHeader({
      name: "tunnel",
      executable: "/opt/homebrew/bin/cloudflared",
      args: ["tunnel", "run", "--token", "eyJhIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAifQ"],
    });
    expect(header).toBe("tunnel: /opt/homebrew/bin/cloudflared tunnel run --token ***");
  });
});

describe("spawn failures (A9)", () => {
  it("throws a LaunchError for a missing executable and does not crash later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-"));
    const launcher = new SpawnLauncher();
    expect(() =>
      launcher.launch({
        name: "ghost",
        executable: join(dir, "does-not-exist"),
        args: ["--token", "eyJzZWNyZXQiOiIwMTIzNDU2Nzg5YWJjZGVmIn0"],
        env: { PATH: "/usr/bin" },
        cwd: dir,
        logFile: join(dir, "ghost.log"),
      }),
    ).toThrow(LaunchError);
    // The child's "error" event arrives later; without a listener it would crash the process.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = readFileSync(join(dir, "ghost.log"), "utf8");
    expect(log).toContain("ghost:");
    expect(log).not.toContain("eyJzZWNyZXQiOiIwMTIzNDU2Nzg5YWJjZGVmIn0");
  });
});

describe("sealed host secrets (G10)", () => {
  it("seals new secrets; nothing secret is left in plain files", () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-"));
    const first = loadOrCreateHostSecrets(dir, cipher);
    expect(loadOrCreateHostSecrets(dir, cipher)).toEqual(first);
    expect(readdirSync(dir)).toEqual(["host-secrets.json"]);
    expect(statSync(join(dir, "host-secrets.json")).mode & 0o777).toBe(0o600);
    const raw = readFileSync(join(dir, "host-secrets.json"), "utf8");
    expect(raw).not.toContain(first.workerToken);
    expect(raw).not.toContain(first.vaultKey);
  });

  it("migrates the old plain files once and deletes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-"));
    writeFileSync(join(dir, "worker-token"), `${"a".repeat(64)}\n`);
    writeFileSync(join(dir, "vault-key"), "b".repeat(44));
    expect(loadOrCreateHostSecrets(dir, cipher)).toEqual({
      workerToken: "a".repeat(64),
      vaultKey: "b".repeat(44),
    });
    expect(readdirSync(dir)).toEqual(["host-secrets.json"]);
    expect(loadOrCreateHostSecrets(dir, cipher).vaultKey).toBe("b".repeat(44));
  });

  it("keeps the sealed key and drops a stray plain copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-"));
    const original = loadOrCreateHostSecrets(dir, cipher);
    writeFileSync(join(dir, "vault-key"), "c".repeat(44));
    expect(loadOrCreateHostSecrets(dir, cipher).vaultKey).toBe(original.vaultKey);
    expect(readdirSync(dir)).toEqual(["host-secrets.json"]);
  });

  it("never replaces a sealed key it cannot open", () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-"));
    loadOrCreateHostSecrets(dir, cipher);
    const broken: Cipher = { ...cipher, decrypt: () => "" };
    expect(() => loadOrCreateHostSecrets(dir, broken)).toThrow(HostSecretsError);
    const unavailable: Cipher = { ...cipher, available: () => false };
    expect(() => loadOrCreateHostSecrets(dir, unavailable)).toThrow(HostSecretsError);
  });

  it("restores secrets from a backup into the sealed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-"));
    loadOrCreateHostSecrets(dir, cipher);
    const restored = { workerToken: "d".repeat(64), vaultKey: "e".repeat(44) };
    writeHostSecrets(dir, restored, cipher);
    expect(loadOrCreateHostSecrets(dir, cipher)).toEqual(restored);
    expect(() => writeHostSecrets(dir, { workerToken: "x", vaultKey: "y" }, cipher)).toThrow(
      HostSecretsError,
    );
  });
});

describe("owner secret on the app's own requests (G1)", () => {
  it("goes to the API port and the dev renderer's /api only", () => {
    const dev = "http://127.0.0.1:5183";
    expect(needsOwnerHeader("ws://127.0.0.1:8790/api/jobs/stream", 8790, null)).toBe(true);
    expect(needsOwnerHeader("http://localhost:8790/api/brands", 8790, null)).toBe(true);
    expect(needsOwnerHeader("http://127.0.0.1:5183/api/brands", 8790, dev)).toBe(true);
    for (const url of [
      "ws://127.0.0.1:8791/api/jobs/stream", // the LAN gateway
      "http://127.0.0.1:8790/api/x".replace("8790", "9999"),
      "https://example.com/api/brands",
      "http://127.0.0.1:5183/index.html",
      "http://evil.example:8790/api/brands",
      "studio://app/api/brands", // the protocol handler adds it itself
      "not a url",
    ]) {
      expect(needsOwnerHeader(url, 8790, dev), url).toBe(false);
    }
    expect(needsOwnerHeader("http://127.0.0.1:8790/api/brands", null, null)).toBe(false);
  });

  it("reads origins of custom schemes too", () => {
    expect(originOf("studio://app/index.html")).toBe("studio://app");
    expect(originOf("http://127.0.0.1:5183/a?b")).toBe("http://127.0.0.1:5183");
    expect(originOf("garbage")).toBeNull();
  });
});

describe("web permissions (G7)", () => {
  const app = ["studio://app", "http://127.0.0.1:5183"];

  it("allows only what the app uses, only for its own pages", () => {
    for (const permission of ["clipboard-sanitized-write", "clipboard-read", "pointerLock"]) {
      expect(permissionAllowed(permission, "studio://app/index.html", app), permission).toBe(true);
    }
    expect(permissionAllowed("fullscreen", "http://127.0.0.1:5183/", app)).toBe(true);
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "display-capture",
      "midi",
      "openExternal",
      "fileSystem",
      "unknown",
    ]) {
      expect(permissionAllowed(permission, "studio://app/index.html", app), permission).toBe(false);
    }
    expect(permissionAllowed("clipboard-read", "https://example.com/", app)).toBe(false);
    expect(permissionAllowed("clipboard-read", undefined, app)).toBe(false);
  });
});
