import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StudioClient } from "../src/client.ts";
import { checkBaseUrl, isLoopbackUrl, resolveBaseUrl } from "../src/config.ts";
import { FileRefused, readUploadFile } from "../src/files.ts";
import { dangerFor, isSecretKey, REDACTED, redact, redactText } from "../src/safety.ts";

describe("loopback enforcement", () => {
  it("accepts only loopback http(s) URLs", () => {
    for (const ok of [
      "http://127.0.0.1:8790",
      "http://localhost:9000/",
      "http://[::1]:8790",
      "https://127.0.0.1",
    ]) {
      expect(isLoopbackUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://example.com",
      "http://127.0.0.1.evil.com",
      "http://localhost.evil.com:8790",
      "http://user:pass@127.0.0.1:8790",
      "http://10.0.0.5:8790",
      "http://192.168.1.2:8791",
      "file:///etc/passwd",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(isLoopbackUrl(bad), bad).toBe(false);
    }
  });

  it("refuses a non-loopback STUDIO_API_URL", () => {
    expect(() =>
      resolveBaseUrl({ STUDIO_API_URL: "https://evil.example" }, "/nonexistent"),
    ).toThrow(/127\.0\.0\.1/);
    expect(resolveBaseUrl({ STUDIO_API_URL: "http://localhost:9999/x" }, "/nonexistent")).toBe(
      "http://localhost:9999",
    );
    expect(resolveBaseUrl({}, "/nonexistent")).toBe("http://127.0.0.1:8790");
    expect(() => checkBaseUrl("http://8.8.8.8")).toThrow();
    expect(() => new StudioClient({ baseUrl: "http://evil.example", stateDir: "/x" })).toThrow();
  });

  it("uses host.json's port when the app chose another one", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-mcp-host-"));
    writeFileSync(join(dir, "host.json"), JSON.stringify({ apiPort: 8801, pid: 1 }));
    expect(resolveBaseUrl({}, dir)).toBe("http://127.0.0.1:8801");
    rmSync(dir, { recursive: true, force: true });
  });

  it("never builds a URL off the API origin", () => {
    const client = new StudioClient({ baseUrl: "http://127.0.0.1:8790", stateDir: "/x" });
    expect(client.url("/api/brands", { limit: 5 }).href).toBe(
      "http://127.0.0.1:8790/api/brands?limit=5",
    );
    for (const bad of [
      "//evil.com/api/x",
      "http://evil.com/api/x",
      "/api/../etc",
      "/other",
      "/api/x?y=1",
      "/api/x#y",
      "/api/x\\y",
    ]) {
      expect(() => client.url(bad), bad).toThrow();
    }
  });
});

describe("redaction", () => {
  it("knows secret keys", () => {
    for (const key of [
      "token",
      "accessToken",
      "access_token",
      "refreshToken",
      "apiKey",
      "api_key",
      "secret",
      "clientSecret",
      "password",
      "qrSecret",
      "publisherToken",
      "privateKey",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["tokenHealth", "tokenExpiresAt", "inputTokens", "keys", "name", "hint"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it("replaces secret values deep inside responses and keeps flags", () => {
    const out = redact({
      items: [{ id: "a", accessToken: "EAAB123", hasToken: true, tokenHealth: { ok: true } }],
      provider: { apiKey: "sk-123", hint: "…abcd" },
      nested: { credentials: { password: "x" } },
      cloud: { token: null },
    });
    expect(out).toEqual({
      items: [{ id: "a", accessToken: REDACTED, hasToken: true, tokenHealth: { ok: true } }],
      provider: { apiKey: REDACTED, hint: "…abcd" },
      nested: { credentials: REDACTED },
      cloud: { token: null },
    });
  });

  it("removes recognisable secrets from free text", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactText(`key sk-${"a".repeat(30)} end`)).toBe(`key ${REDACTED} end`);
    expect(redactText(`AIza${"b".repeat(35)}`)).toBe(REDACTED);
  });
});

describe("dangerous operation classification", () => {
  it("covers deletes, publishing, accounts, devices, keys, money and budget", () => {
    expect(dangerFor("DELETE", "/api/assets/{id}")).not.toBeNull();
    expect(dangerFor("POST", "/api/schedules/publish-now")).not.toBeNull();
    expect(dangerFor("POST", "/api/social-accounts/{id}/disconnect")).not.toBeNull();
    expect(dangerFor("POST", "/api/devices/{id}/revoke")).not.toBeNull();
    expect(dangerFor("PUT", "/api/ai/keys/{provider}")).not.toBeNull();
    expect(dangerFor("PUT", "/api/ai/budget")).not.toBeNull();
    expect(dangerFor("POST", "/api/plans/{id}/generate")).not.toBeNull();
    expect(dangerFor("GET", "/api/assets/{id}")).toBeNull();
    expect(dangerFor("POST", "/api/conversations/{id}/messages")).toBeNull();
  });

  it("depends on the arguments where it should", () => {
    const jobs = "/api/jobs";
    expect(dangerFor("POST", jobs, { body: { type: "image.generate" } })).not.toBeNull();
    expect(dangerFor("POST", jobs, { body: { type: "content.generate" } })).not.toBeNull();
    expect(dangerFor("POST", jobs, { body: { type: "demo.echo" } })).toBeNull();
    const consent = "/api/conversations/{id}/messages/{messageId}/consent";
    expect(dangerFor("POST", consent, { body: { consentId: "c", allow: true } })).not.toBeNull();
    expect(dangerFor("POST", consent, { body: { consentId: "c", allow: false } })).toBeNull();
  });
});

describe("upload file checks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-mcp-files-")));
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(join(home, "Pictures"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "Library", "Application Support", "Studio"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(home, "Pictures", "a.png"), png);
  writeFileSync(join(home, "Pictures", "empty.png"), "");
  writeFileSync(join(home, "Pictures", "big.png"), Buffer.alloc(2048));
  writeFileSync(join(home, "Pictures", "notes.txt"), "hello");
  writeFileSync(join(home, ".ssh", "id.png"), png);
  writeFileSync(join(home, "Library", "Application Support", "Studio", "owner-secret.png"), png);
  writeFileSync(join(outside, "b.png"), png);
  symlinkSync(join(outside, "b.png"), join(home, "Pictures", "link.png"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const read = (p: string) => readUploadFile(p, { home, maxBytes: 1024 });

  it("reads a regular media file inside the home folder", () => {
    const file = read(join(home, "Pictures", "a.png"));
    expect(file.mimeType).toBe("image/png");
    expect(file.name).toBe("a.png");
    expect(Buffer.from(file.bytes)).toEqual(png);
  });

  it("refuses everything else", () => {
    for (const p of [
      "Pictures/a.png", // relative
      join(outside, "b.png"), // outside home
      join(home, "Pictures", "link.png"), // symlink out of home
      join(home, ".ssh", "id.png"), // hidden folder
      join(home, "Library", "Application Support", "Studio", "owner-secret.png"),
      join(home, "Pictures"), // directory
      join(home, "Pictures", "missing.png"),
      join(home, "Pictures", "empty.png"),
      join(home, "Pictures", "big.png"), // over the limit
      join(home, "Pictures", "notes.txt"), // not a media type
      join(home, "Pictures", "..", "..", "outside", "b.png"),
    ]) {
      expect(() => read(p), p).toThrow(FileRefused);
    }
  });
});
