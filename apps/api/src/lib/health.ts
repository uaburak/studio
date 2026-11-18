import {
  type HealthComponent,
  type HealthState,
  isCanvasRunner,
  type MacRoutes,
  type WorkerPresence,
} from "@studio/contract";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { loadPublishingSettings } from "./publishing.ts";
import { type VaultEnv, vaultReady } from "./token-vault.ts";

/*
 * `/api/health` for the Mac itself (P9): every part of the host, each ok / warn / fail with a
 * Turkish label and one line on what to do. Settings → Gelişmiş shows the list; the desktop's
 * self-test checks it.
 */

/**
 * The last migration this build ships (`migrations/`). A test keeps it equal to the folder's
 * last file, so a new migration without this bump fails CI instead of reporting "behind".
 */
export const LATEST_MIGRATION = "0021_planning.sql";

export interface MigrationLevel {
  applied: number;
  last: string | null;
  expected: string;
}

export async function migrationLevel(db: Db): Promise<MigrationLevel> {
  try {
    const rows = await db.all<{ name: string }>(sql`select name from d1_migrations order by id`);
    return {
      applied: rows.length,
      last: rows.at(-1)?.name ?? null,
      expected: LATEST_MIGRATION,
    };
  } catch {
    return { applied: 0, last: null, expected: LATEST_MIGRATION };
  }
}

/** A cloud publisher sync older than this (while one is configured) is worth a look. */
const STALE_SYNC_MS = 60 * 60_000;

function component(
  id: HealthComponent["id"],
  state: HealthState,
  label: string,
  detail: string,
): HealthComponent {
  return { id, state, label, detail: detail.slice(0, 500) };
}

function istanbulTime(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return date.toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface HealthInputs {
  db: Db;
  dbOk: boolean;
  env: VaultEnv & { MEDIA: R2Bucket };
  presence: () => Promise<WorkerPresence>;
  routes: () => Promise<MacRoutes | null>;
  now?: number;
}

export async function hostComponents(
  input: HealthInputs,
): Promise<{ components: HealthComponent[]; migrations: MigrationLevel }> {
  const now = input.now ?? Date.now();
  const out: HealthComponent[] = [];

  out.push(
    input.dbOk
      ? component("db", "ok", "Veritabanı", "D1 veritabanı yanıt veriyor.")
      : component(
          "db",
          "fail",
          "Veritabanı",
          "D1 veritabanı yanıt vermiyor. Sunucuyu yeniden başlat.",
        ),
  );

  try {
    await input.env.MEDIA.head("__studio_health__");
    out.push(component("storage", "ok", "Medya deposu", "R2 deposu yanıt veriyor."));
  } catch (error) {
    out.push(
      component(
        "storage",
        "fail",
        "Medya deposu",
        `R2 deposu yanıt vermiyor: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const migrations = input.dbOk
    ? await migrationLevel(input.db)
    : { applied: 0, last: null, expected: LATEST_MIGRATION };
  if (migrations.last === migrations.expected) {
    out.push(
      component(
        "migrations",
        "ok",
        "Veritabanı sürümü",
        `Güncel (${migrations.applied} güncelleme, son: ${migrations.last}).`,
      ),
    );
  } else if (migrations.last && migrations.last > migrations.expected) {
    out.push(
      component(
        "migrations",
        "warn",
        "Veritabanı sürümü",
        `Veritabanı bu uygulamadan yeni (${migrations.last}); daha yeni bir Studio ile açılmış olabilir.`,
      ),
    );
  } else {
    out.push(
      component(
        "migrations",
        "fail",
        "Veritabanı sürümü",
        `Veritabanı güncel değil (son: ${migrations.last ?? "yok"}, beklenen: ${migrations.expected}). Sunucuyu yeniden başlat; güncelleme açılışta uygulanır.`,
      ),
    );
  }

  let presence: WorkerPresence | null = null;
  try {
    presence = await input.presence();
  } catch {
    presence = null;
  }
  const workers = presence?.workers ?? [];
  const mac = workers.filter((w) => !isCanvasRunner(w.capabilities));
  const canvas = workers.filter((w) => isCanvasRunner(w.capabilities));
  if (presence === null) {
    out.push(component("worker", "fail", "Worker", "İş kuyruğu yanıt vermiyor."));
  } else if (mac.some((w) => !w.draining)) {
    out.push(
      component(
        "worker",
        "ok",
        "Worker",
        `Bağlı (${mac.length}); kuyrukta ${presence.queueLength} iş, çalışan ${presence.currentJobs.length}.`,
      ),
    );
  } else {
    out.push(
      component(
        "worker",
        "fail",
        "Worker",
        presence.lastSeenAt
          ? `Bağlı değil (son görülme: ${istanbulTime(presence.lastSeenAt)}). İşler bekliyor; ayrıntı worker.log'da.`
          : "Bağlı değil. İşler bekliyor; ayrıntı worker.log'da.",
      ),
    );
  }
  out.push(
    canvas.length > 0
      ? component("canvas", "ok", "Tuval çalıştırıcısı", "Bağlı: tuval işleri bu Mac'te çalışır.")
      : component(
          "canvas",
          "warn",
          "Tuval çalıştırıcısı",
          "Bağlı değil: yapay zekânın tuval işleri Studio uygulaması açılınca çalışır.",
        ),
  );

  out.push(
    vaultReady(input.env)
      ? component("vault", "ok", "Anahtar kasası", "Hesap ve API anahtarları şifrelenebiliyor.")
      : component(
          "vault",
          "fail",
          "Anahtar kasası",
          "Kasa anahtarı yok: hesap bağlantıları ve API anahtarları kaydedilemez. Studio uygulamasını yeniden başlat.",
        ),
  );

  if (input.dbOk) {
    const settings = await loadPublishingSettings(input.db).catch(() => null);
    const configured = Boolean(settings?.cloudUrl && settings.cloudTokenCiphertext);
    const lastSync = settings?.lastSyncAt ?? null;
    if (!configured && !lastSync) {
      out.push(
        component("cloud", "ok", "Bulut yayıncı", "Kapalı: zamanlanan postları bu Mac yayınlar."),
      );
    } else if (!lastSync) {
      out.push(
        component(
          "cloud",
          "warn",
          "Bulut yayıncı",
          "Ayarlı ama henüz eşitlenmedi. Worker bağlıysa birkaç dakika içinde eşitler.",
        ),
      );
    } else if (settings?.lastSyncOk === false) {
      out.push(
        component(
          "cloud",
          "fail",
          "Bulut yayıncı",
          `Son eşitleme başarısız (${istanbulTime(lastSync)}): ${settings.lastSyncError ?? "bilinmeyen hata"}`,
        ),
      );
    } else if (now - lastSync.getTime() > STALE_SYNC_MS) {
      out.push(
        component(
          "cloud",
          "warn",
          "Bulut yayıncı",
          `Son eşitleme ${istanbulTime(lastSync)}: bir saatten eski. Worker bağlı mı?`,
        ),
      );
    } else {
      out.push(
        component(
          "cloud",
          "ok",
          "Bulut yayıncı",
          `Ulaşılıyor; son eşitleme ${istanbulTime(lastSync)}.`,
        ),
      );
    }
  }

  const routes = await input.routes().catch(() => null);
  const tunnel = routes?.tunnel;
  if (tunnel) {
    out.push(
      component(
        "tunnel",
        tunnel.state === "off" ? "ok" : tunnel.state,
        "Uzaktan erişim",
        tunnel.detail || (tunnel.state === "off" ? "Kapalı." : ""),
      ),
    );
  } else if (routes?.tunnelUrl) {
    out.push(component("tunnel", "ok", "Uzaktan erişim", `Açık: ${routes.tunnelUrl}`));
  } else {
    out.push(component("tunnel", "ok", "Uzaktan erişim", "Kapalı."));
  }

  return { components: out, migrations };
}
