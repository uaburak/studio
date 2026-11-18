import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackupService, type BackupServiceDeps } from "../../src/main/backup-service.ts";
import {
  type Archiver,
  type BackupSecrets,
  openBackup,
  persistedState,
  snapshotDatabase,
  writeBackup,
} from "../../src/main/host/backup.ts";

/** "Zips" a folder into one JSON file (the app uses macOS ditto). */
const asFolderZip: Archiver = {
  async pack(folder, zip) {
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const key = rel ? `${rel}/${name}` : name;
        if (statSync(path).isDirectory()) walk(path, key);
        else files[key] = readFileSync(path).toString("base64");
      }
    };
    walk(folder, basename(folder));
    writeFileSync(zip, JSON.stringify(files));
  },
  async unpack(zip, into) {
    const files = JSON.parse(readFileSync(zip, "utf8")) as Record<string, string>;
    for (const [key, data] of Object.entries(files)) {
      const path = join(into, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
    }
  },
};

function stateWithData(label: string): string {
  const stateDir = mkdtempSync(join(tmpdir(), "studio-state-"));
  const d1 = join(persistedState(stateDir), "d1", "miniflare-D1DatabaseObject");
  const blobs = join(persistedState(stateDir), "r2", "studio-media", "blobs");
  mkdirSync(d1, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(d1, "db.sqlite"), `db-${label}`);
  writeFileSync(join(d1, "db.sqlite-wal"), `wal-${label}`);
  writeFileSync(join(blobs, "blob-1"), `blob-${label}`);
  return stateDir;
}

const SECRETS: BackupSecrets = {
  workerToken: "w".repeat(64),
  vaultKey: "v".repeat(44),
  ownerSecret: "o".repeat(64),
  instanceId: "inst-1234-5678",
};

describe("automatic database copy before migrations (G5)", () => {
  it("copies sqlite, wal and shm, and keeps the newest five", () => {
    const stateDir = stateWithData("a");
    for (let i = 0; i < 7; i++) {
      snapshotDatabase(stateDir, new Date(Date.UTC(2026, 10, 18, 10, i)));
    }
    const root = join(stateDir, "backups", "auto");
    const kept = readdirSync(root).sort();
    expect(kept).toHaveLength(5);
    expect(kept[0]).toBe("2026-11-18T10-02-00-000Z");
    const copy = join(root, kept[4] ?? "", "d1", "miniflare-D1DatabaseObject");
    expect(readFileSync(join(copy, "db.sqlite"), "utf8")).toBe("db-a");
    expect(readFileSync(join(copy, "db.sqlite-wal"), "utf8")).toBe("wal-a");
    expect(statSync(join(stateDir, "backups", "auto")).mode & 0o777).toBe(0o700);
  });

  it("does nothing on a first run and never overwrites a copy made in the same millisecond", () => {
    const empty = mkdtempSync(join(tmpdir(), "studio-state-"));
    expect(snapshotDatabase(empty)).toBeNull();
    const stateDir = stateWithData("b");
    const at = new Date("2026-11-18T10:00:00.000Z");
    const first = snapshotDatabase(stateDir, at);
    const second = snapshotDatabase(stateDir, at);
    expect(second).not.toBe(first);
    expect(readdirSync(join(stateDir, "backups", "auto"))).toHaveLength(2);
  });
});

describe("backup files (G6)", () => {
  it("round-trips data and keys and refuses anything else", async () => {
    const stateDir = stateWithData("a");
    const out = mkdtempSync(join(tmpdir(), "studio-out-"));
    const zip = join(out, "yedek.zip");
    await writeBackup({
      stateDir,
      secrets: SECRETS,
      destination: zip,
      version: "0.1.0",
      archiver: asFolderZip,
    });
    const opened = await openBackup(zip, asFolderZip);
    expect(opened.secrets).toEqual(SECRETS);
    expect(opened.manifest).toMatchObject({ app: "Studio", format: 1, version: "0.1.0" });
    expect(readFileSync(join(opened.state, "r2", "studio-media", "blobs", "blob-1"), "utf8")).toBe(
      "blob-a",
    );
    opened.close();

    const notBackup = join(out, "other.zip");
    writeFileSync(notBackup, "hello");
    await expect(openBackup(notBackup, asFolderZip)).rejects.toThrow("Studio yedeği değil");
  });

  it("refuses to write a backup of a Mac without data", async () => {
    const empty = mkdtempSync(join(tmpdir(), "studio-state-"));
    await expect(
      writeBackup({
        stateDir: empty,
        secrets: SECRETS,
        destination: join(empty, "x.zip"),
        version: "1",
        archiver: asFolderZip,
      }),
    ).rejects.toThrow("bulunamadı");
  });
});

function service(stateDir: string, overrides: Partial<BackupServiceDeps> = {}) {
  const applied: BackupSecrets[] = [];
  const stops: string[] = [];
  const deps: BackupServiceDeps = {
    stateDir,
    version: "0.1.0",
    withStoppedHost: async (message, task) => {
      stops.push(message);
      return task();
    },
    readSecrets: () => SECRETS,
    applySecrets: (s) => applied.push(s),
    chooseDestination: vi.fn(async () => null),
    chooseBackup: vi.fn(async () => null),
    archiver: asFolderZip,
    now: () => new Date("2026-11-18T12:00:00.000Z"),
    ...overrides,
  };
  return { svc: new BackupService(deps), applied, stops, deps };
}

describe("Yedekle / Yedekten geri yükle", () => {
  it("does nothing when the dialog is cancelled", async () => {
    const { svc, stops } = service(stateWithData("a"));
    expect(await svc.backup()).toEqual({ status: "cancelled", message: "" });
    expect(await svc.restore()).toEqual({ status: "cancelled", message: "" });
    expect(stops).toEqual([]);
  });

  it("backs up while the host is paused", async () => {
    const stateDir = stateWithData("a");
    const zip = join(mkdtempSync(join(tmpdir(), "studio-out-")), "y.zip");
    const { svc, stops, deps } = service(stateDir, { chooseDestination: async () => zip });
    const result = await svc.backup();
    expect(result.status).toBe("done");
    expect(result.message).toContain(zip);
    expect(stops).toEqual(["Yedekleniyor"]);
    expect((await openBackup(zip, deps.archiver)).secrets).toEqual(SECRETS);
  });

  it("restores: keeps the current data aside, puts the backup in place, applies its keys", async () => {
    const source = stateWithData("old-mac");
    const zip = join(mkdtempSync(join(tmpdir(), "studio-out-")), "y.zip");
    await writeBackup({
      stateDir: source,
      secrets: { ...SECRETS, instanceId: "old-mac-instance" },
      destination: zip,
      version: "0.1.0",
      archiver: asFolderZip,
    });

    const stateDir = stateWithData("current");
    const { svc, applied, stops } = service(stateDir, { chooseBackup: async () => zip });
    const result = await svc.restore();
    expect(result.status, result.message).toBe("done");
    expect(stops).toEqual(["Yedek geri yükleniyor"]);
    expect(applied).toEqual([{ ...SECRETS, instanceId: "old-mac-instance" }]);
    const d1 = join(persistedState(stateDir), "d1", "miniflare-D1DatabaseObject");
    expect(readFileSync(join(d1, "db.sqlite"), "utf8")).toBe("db-old-mac");
    const blobs = join(persistedState(stateDir), "r2", "studio-media", "blobs");
    expect(readFileSync(join(blobs, "blob-1"), "utf8")).toBe("blob-old-mac");
    // The data it replaced was saved as a backup first.
    const previous = join(stateDir, "backups", "before-restore-2026-11-18T12-00-00-000Z.zip");
    expect(existsSync(previous)).toBe(true);
    expect(result.message).toContain(previous);
    const kept = await openBackup(previous, asFolderZip);
    expect(
      readFileSync(join(kept.state, "d1", "miniflare-D1DatabaseObject", "db.sqlite"), "utf8"),
    ).toBe("db-current");
    kept.close();
    // No leftovers of the swap.
    expect(readdirSync(persistedState(stateDir)).sort()).toEqual(["d1", "r2"]);
  });

  it("restores even when the current keys cannot be opened, keeping the current data", async () => {
    const source = stateWithData("old-mac");
    const zip = join(mkdtempSync(join(tmpdir(), "studio-out-")), "y.zip");
    await writeBackup({
      stateDir: source,
      secrets: SECRETS,
      destination: zip,
      version: "0.1.0",
      archiver: asFolderZip,
    });
    const stateDir = stateWithData("current");
    const { svc, applied } = service(stateDir, {
      chooseBackup: async () => zip,
      readSecrets: () => {
        throw new Error("Şifreli anahtar (vault-key) çözülemedi.");
      },
    });
    const result = await svc.restore();
    expect(result.status, result.message).toBe("done");
    expect(applied).toHaveLength(1);
    const kept = join(stateDir, "backups", "before-restore-2026-11-18T12-00-00-000Z");
    expect(result.message).toContain(kept);
    expect(readFileSync(join(kept, "d1", "miniflare-D1DatabaseObject", "db.sqlite"), "utf8")).toBe(
      "db-current",
    );
    const d1 = join(persistedState(stateDir), "d1", "miniflare-D1DatabaseObject");
    expect(readFileSync(join(d1, "db.sqlite"), "utf8")).toBe("db-old-mac");
  });

  it("says so when the file is not a backup, and touches nothing", async () => {
    const stateDir = stateWithData("current");
    const bad = join(mkdtempSync(join(tmpdir(), "studio-out-")), "bad.zip");
    writeFileSync(bad, "x");
    const { svc, applied, stops } = service(stateDir, { chooseBackup: async () => bad });
    const result = await svc.restore();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Studio yedeği değil");
    expect(stops).toEqual([]);
    expect(applied).toEqual([]);
  });

  it("reports a host that cannot be paused", async () => {
    const stateDir = stateWithData("a");
    const zip = join(mkdtempSync(join(tmpdir(), "studio-out-")), "y.zip");
    const { svc } = service(stateDir, {
      chooseDestination: async () => zip,
      withStoppedHost: async () => {
        throw new Error("Sunucu başka bir Studio uygulamasında çalışıyor.");
      },
    });
    const result = await svc.backup();
    expect(result).toEqual({
      status: "failed",
      message: "Yedek alınamadı: Sunucu başka bir Studio uygulamasında çalışıyor.",
    });
  });
});
