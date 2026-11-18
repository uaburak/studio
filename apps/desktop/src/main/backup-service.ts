// Ayarlar → Gelişmiş → Yedekle / Yedekten geri yükle (G6): the flows around host/backup.ts,
// Electron-free (dialogs, the host and the secrets are injected) so they are tested on their own.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BackupResult } from "../shared/accounts-ipc.ts";
import {
  type Archiver,
  BackupError,
  type BackupSecrets,
  backupsFolder,
  dittoArchiver,
  installBackupData,
  openBackup,
  stamp,
  writeBackup,
} from "./host/backup.ts";

export interface BackupServiceDeps {
  stateDir: string;
  version: string;
  /** Runs a task while the host's children are stopped, then starts the host again. */
  withStoppedHost<T>(message: string, task: () => Promise<T>): Promise<T>;
  /** The secrets that belong with the current data. */
  readSecrets(): BackupSecrets;
  /** Makes restored secrets current (sealed vault key / worker token, owner secret, host id). */
  applySecrets(secrets: BackupSecrets): void;
  /** Save dialog; null when cancelled. */
  chooseDestination(defaultName: string): Promise<string | null>;
  /** Open dialog; null when cancelled. */
  chooseBackup(): Promise<string | null>;
  archiver?: Archiver;
  now?: () => Date;
}

function message(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class BackupService {
  private busy = false;

  constructor(private readonly deps: BackupServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async exclusive(run: () => Promise<BackupResult>): Promise<BackupResult> {
    if (this.busy) return { status: "failed", message: "Bir yedekleme işlemi zaten sürüyor." };
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }

  /** Asks where, stops the host for a moment, writes the zip, starts the host again. */
  backup(): Promise<BackupResult> {
    return this.exclusive(async () => {
      const destination = await this.deps.chooseDestination(`Studio-yedek-${day(this.now())}.zip`);
      if (!destination) return { status: "cancelled", message: "" };
      try {
        await this.deps.withStoppedHost("Yedekleniyor", () =>
          writeBackup({
            stateDir: this.deps.stateDir,
            secrets: this.deps.readSecrets(),
            destination,
            version: this.deps.version,
            archiver: this.deps.archiver ?? dittoArchiver,
            now: this.now(),
          }),
        );
        return {
          status: "done",
          message: `Yedek kaydedildi: ${destination}. Dosya hesap anahtarlarını da içerir; güvenli bir yerde sakla.`,
        };
      } catch (error) {
        return { status: "failed", message: `Yedek alınamadı: ${message(error)}` };
      }
    });
  }

  /**
   * Asks for a backup, checks it, stops the host, saves the current data next to the other
   * backups, puts the backup's data and keys in place and starts the host again.
   */
  restore(): Promise<BackupResult> {
    return this.exclusive(async () => {
      const file = await this.deps.chooseBackup();
      if (!file) return { status: "cancelled", message: "" };
      const archiver = this.deps.archiver ?? dittoArchiver;
      let opened: Awaited<ReturnType<typeof openBackup>>;
      try {
        opened = await openBackup(file, archiver);
      } catch (error) {
        return { status: "failed", message: message(error) };
      }
      try {
        const saved = await this.deps.withStoppedHost("Yedek geri yükleniyor", async () => {
          const now = this.now();
          const folder = backupsFolder(this.deps.stateDir);
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          const previous = join(folder, `before-restore-${stamp(now)}.zip`);
          let kept: string | null = previous;
          let keepIn: string | undefined;
          let current: BackupSecrets | null;
          try {
            current = this.deps.readSecrets();
          } catch {
            // The current keys cannot be opened (that is often why one restores): keep the
            // current data as a plain folder instead of a backup zip.
            current = null;
          }
          if (current) {
            try {
              await writeBackup({
                stateDir: this.deps.stateDir,
                secrets: current,
                destination: previous,
                version: this.deps.version,
                archiver,
                now,
              });
            } catch (error) {
              // A Mac without data yet has nothing to keep; anything else stops the restore.
              if (!(error instanceof BackupError && /bulunamadı/.test(error.message))) throw error;
              kept = null;
            }
          } else {
            keepIn = join(folder, `before-restore-${stamp(now)}`);
            kept = keepIn;
          }
          // Keys first: if they cannot be written, nothing has changed yet.
          this.deps.applySecrets(opened.secrets);
          try {
            installBackupData(this.deps.stateDir, opened, now, keepIn);
          } catch (error) {
            // The data was moved back; put the keys that belong to it back too.
            if (current) {
              try {
                this.deps.applySecrets(current);
              } catch {
                // the error below says what failed
              }
            }
            throw error;
          }
          return kept;
        });
        const when = new Date(opened.manifest.createdAt);
        const date = Number.isNaN(when.getTime()) ? "" : ` (${day(when)})`;
        return {
          status: "done",
          message: `Yedek geri yüklendi${date}. Sunucu yeniden başlıyor.${saved ? ` Önceki veriler şuraya kaydedildi: ${saved}` : ""}`,
        };
      } catch (error) {
        return { status: "failed", message: `Yedek geri yüklenemedi: ${message(error)}` };
      } finally {
        opened.close();
      }
    });
  }
}
