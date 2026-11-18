// Copies of the owner's data (G5, G6).
//
// - Before every start applies D1 migrations, the host copies the D1 database (sqlite + -wal +
//   -shm; nothing runs at that point, so the copy is consistent) to
//   `backups/auto/<time>/d1` and keeps the newest AUTO_SNAPSHOTS_KEPT.
// - Ayarlar → Gelişmiş → Yedekle writes one zip with the D1 database, the R2 objects (media),
//   the vault key, the worker token, the owner secret and the Mac's host id; "Yedekten geri
//   yükle" puts them back. Both run while the host's children are stopped (consistent files);
//   a restore first saves the current data as `backups/before-restore-<time>.zip`.
//   The zip holds the vault key in plain text (it has to work on another Mac, whose Keychain
//   cannot open this one's), so it is written 0600 and the UI says to keep it somewhere safe.
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BACKUP_FORMAT = 1;
export const AUTO_SNAPSHOTS_KEPT = 5;
/** Folder name inside the zip. */
const ROOT_NAME = "Studio-yedek";
/** The parts of wrangler's persist folder that hold the owner's data. */
const DATA_PARTS = ["d1", "r2"] as const;

export class BackupError extends Error {}

export interface BackupSecrets {
  workerToken: string;
  vaultKey: string;
  ownerSecret: string;
  instanceId: string;
}

export interface BackupManifest {
  format: number;
  app: "Studio";
  createdAt: string;
  version: string;
}

/** Zip in / out (macOS `ditto` in the app; a folder copy in tests). */
export interface Archiver {
  pack(folder: string, zip: string): Promise<void>;
  unpack(zip: string, into: string): Promise<void>;
}

function ditto(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/ditto", args, { timeout: 10 * 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new BackupError(`ditto: ${String(stderr || error.message).trim()}`));
      else resolve();
    });
  });
}

export const dittoArchiver: Archiver = {
  pack: (folder, zip) => ditto(["-c", "-k", "--sequesterRsrc", "--keepParent", folder, zip]),
  unpack: (zip, into) => ditto(["-x", "-k", zip, into]),
};

/** wrangler's `--persist-to` folder (v3 layout). */
export function persistedState(stateDir: string): string {
  return join(stateDir, "api", "state", "v3");
}

export function backupsFolder(stateDir: string): string {
  return join(stateDir, "backups");
}

/** `2026-11-18T17-05-00-123Z`: sorts by time, safe in file names. */
export function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?$/;

/** G5: a copy of the D1 database before migrations (null on a first run: nothing to copy). */
export function snapshotDatabase(
  stateDir: string,
  now: Date = new Date(),
  keep: number = AUTO_SNAPSHOTS_KEPT,
): string | null {
  const source = join(persistedState(stateDir), "d1");
  if (!existsSync(source)) return null;
  const root = join(backupsFolder(stateDir), "auto");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let target = join(root, stamp(now));
  for (let n = 1; existsSync(target); n++) target = join(root, `${stamp(now)}-${n}`);
  cpSync(source, join(target, "d1"), { recursive: true });
  pruneSnapshots(root, keep);
  return target;
}

/** Deletes all but the newest `keep` snapshots (other files in the folder are left alone). */
export function pruneSnapshots(root: string, keep: number): void {
  const names = readdirSync(root)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

/** Writes a backup zip of `stateDir`'s data and `secrets` to `destination` (0600). */
export async function writeBackup(input: {
  stateDir: string;
  secrets: BackupSecrets;
  destination: string;
  version: string;
  archiver?: Archiver;
  now?: Date;
}): Promise<void> {
  const archiver = input.archiver ?? dittoArchiver;
  const staging = mkdtempSync(join(tmpdir(), "studio-backup-"));
  try {
    const root = join(staging, ROOT_NAME);
    mkdirSync(root, { mode: 0o700 });
    const state = persistedState(input.stateDir);
    for (const part of DATA_PARTS) {
      const from = join(state, part);
      if (existsSync(from)) cpSync(from, join(root, "state", part), { recursive: true });
    }
    if (!existsSync(join(root, "state", "d1"))) {
      throw new BackupError("Yedeklenecek veritabanı bulunamadı (sunucu hiç çalışmamış olabilir).");
    }
    writeFileSync(join(root, "secrets.json"), `${JSON.stringify(input.secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      app: "Studio",
      createdAt: (input.now ?? new Date()).toISOString(),
      version: input.version,
    };
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const zip = join(staging, "backup.zip");
    await archiver.pack(root, zip);
    const tmp = `${input.destination}.${process.pid}.tmp`;
    copyFileSync(zip, tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, input.destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface OpenedBackup {
  manifest: BackupManifest;
  secrets: BackupSecrets;
  /** The backup's `state` folder (d1, r2). */
  state: string;
  /** Removes the unpacked copy. */
  close(): void;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Unpacks and checks a backup zip (nothing in the state folder changes). */
export async function openBackup(
  zip: string,
  archiver: Archiver = dittoArchiver,
): Promise<OpenedBackup> {
  const staging = mkdtempSync(join(tmpdir(), "studio-restore-"));
  const close = () => rmSync(staging, { recursive: true, force: true });
  try {
    await archiver.unpack(zip, staging);
    const root = join(staging, ROOT_NAME);
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    ) as BackupManifest;
    if (manifest?.app !== "Studio" || manifest.format !== BACKUP_FORMAT)
      throw new Error("manifest");
    const raw = JSON.parse(
      readFileSync(join(root, "secrets.json"), "utf8"),
    ) as Partial<BackupSecrets>;
    if (
      !isText(raw.workerToken) ||
      !isText(raw.vaultKey) ||
      !isText(raw.ownerSecret) ||
      !isText(raw.instanceId)
    ) {
      throw new Error("secrets");
    }
    const state = join(root, "state");
    if (!existsSync(join(state, "d1"))) throw new Error("d1");
    return {
      manifest,
      secrets: {
        workerToken: raw.workerToken,
        vaultKey: raw.vaultKey,
        ownerSecret: raw.ownerSecret,
        instanceId: raw.instanceId,
      },
      state,
      close,
    };
  } catch {
    close();
    throw new BackupError("Bu dosya bir Studio yedeği değil ya da bozuk.");
  }
}

/**
 * Puts the backup's D1 and R2 in place of the current ones (the host must be stopped). The
 * current folders are moved aside first and moved back if copying fails; with `keepIn` they stay
 * there afterwards (when they could not be saved as a backup zip).
 */
export function installBackupData(
  stateDir: string,
  backup: OpenedBackup,
  now: Date = new Date(),
  keepIn?: string,
): void {
  const state = persistedState(stateDir);
  mkdirSync(state, { recursive: true });
  const aside = keepIn ?? join(state, `.before-restore-${stamp(now)}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  try {
    for (const part of DATA_PARTS) {
      if (existsSync(join(state, part))) {
        renameSync(join(state, part), join(aside, part));
        moved.push(part);
      }
    }
    for (const part of DATA_PARTS) {
      const from = join(backup.state, part);
      if (existsSync(from)) cpSync(from, join(state, part), { recursive: true });
    }
  } catch (error) {
    for (const part of DATA_PARTS) rmSync(join(state, part), { recursive: true, force: true });
    for (const part of moved) renameSync(join(aside, part), join(state, part));
    rmSync(aside, { recursive: true, force: true });
    throw new BackupError(`Yedek yerine konamadı: ${(error as Error).message}`);
  }
  if (!keepIn) rmSync(aside, { recursive: true, force: true });
}
