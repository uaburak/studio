import {
  DEFAULT_MAX_LATENESS_MINUTES,
  isAllowedCloudPublisherUrl,
  type PublishingMode,
  type PublishingStatus,
} from "@studio/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { publishingSettings } from "../db/schema.ts";
import { ApiProblem } from "./errors.ts";
import { decryptSetting, type VaultEnv, vaultReady } from "./token-vault.ts";

export const SETTINGS_ID = "main";
export const CLOUD_TOKEN_SETTING = "cloud_publisher_token";

/** A worker that synced with a cloud publisher this recently counts as cloud mode. */
const RECENT_SYNC_MS = 10 * 60_000;

export type PublishingSettingsRow = typeof publishingSettings.$inferSelect;

export async function loadPublishingSettings(db: Db): Promise<PublishingSettingsRow | null> {
  return (
    (await db.query.publishingSettings.findFirst({
      where: eq(publishingSettings.id, SETTINGS_ID),
    })) ?? null
  );
}

/** Maximum lateness (S6) in minutes: the saved setting or the 2-hour default. */
export function maxLatenessMinutes(row: PublishingSettingsRow | null): number {
  return row?.maxLatenessMinutes ?? DEFAULT_MAX_LATENESS_MINUTES;
}

/**
 * Statement (for a batch) asking the worker for an immediate cloud sync: a cancelled or
 * approval-revoked schedule must be cancelled at the cloud publisher now, not in 30 s (or
 * hours, if the Mac sleeps right after).
 */
export function requestSyncStatement(db: Db, now: Date) {
  return db
    .insert(publishingSettings)
    .values({ id: SETTINGS_ID, syncRequestedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: publishingSettings.id,
      set: { syncRequestedAt: now, updatedAt: now },
    });
}

/** Upsert part of the single settings row. */
export async function savePublishingSettings(
  db: Db,
  patch: Partial<Omit<PublishingSettingsRow, "id">>,
): Promise<void> {
  const now = new Date();
  await db
    .insert(publishingSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: publishingSettings.id, set: { ...patch, updatedAt: now } });
}

export function publishingMode(
  row: PublishingSettingsRow | null,
  nowMs = Date.now(),
): PublishingMode {
  if (row?.cloudUrl && row.cloudTokenCiphertext) return "cloud";
  // A worker configured with STUDIO_CLOUD_PUBLISHER_URL (old way) reports its syncs.
  if (row?.lastSyncAt && nowMs - row.lastSyncAt.getTime() < RECENT_SYNC_MS) return "cloud";
  return "local";
}

export function toPublishingStatus(
  row: PublishingSettingsRow | null,
  env: VaultEnv,
): PublishingStatus {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    mode: publishingMode(row),
    cloud: {
      configured: Boolean(row?.cloudUrl && row.cloudTokenCiphertext),
      url: row?.cloudUrl ?? null,
      lastSyncAt: iso(row?.lastSyncAt),
      lastSyncOk: row?.lastSyncOk ?? null,
      lastSyncError: row?.lastSyncError ?? null,
      syncRequestedAt: iso(row?.syncRequestedAt),
    },
    vaultReady: vaultReady(env),
    maxLatenessMinutes: maxLatenessMinutes(row),
  };
}

/**
 * The cloud publisher URL and token for the worker; null when no cloud publisher is set.
 *
 * A configured but unreadable token (vault key changed, corrupt row) or a URL that is not
 * allowed any more throws (409): silently answering "no cloud publisher" would make the Mac
 * publish locally what the cloud publisher also holds.
 */
export async function cloudCredentials(
  row: PublishingSettingsRow | null,
  env: VaultEnv,
): Promise<{ url: string; token: string } | null> {
  if (!row?.cloudUrl || !row.cloudTokenCiphertext || !row.cloudTokenIv) return null;
  if (!isAllowedCloudPublisherUrl(row.cloudUrl)) {
    throw new ApiProblem(
      "conflict",
      "Bulut yayıncı adresi https:// değil; Ayarlar → Yayın'da adresi https:// ile yeniden kaydedin.",
    );
  }
  let token: string;
  try {
    token = await decryptSetting(env, CLOUD_TOKEN_SETTING, {
      ciphertext: row.cloudTokenCiphertext,
      iv: row.cloudTokenIv,
      keyVersion: row.cloudTokenKeyVersion,
    });
  } catch {
    throw new ApiProblem(
      "conflict",
      "Bulut yayıncı anahtarı çözülemedi (kasa anahtarı değişmiş olabilir); Ayarlar → Yayın'da bulut yayıncıyı yeniden kaydedin.",
    );
  }
  return { url: row.cloudUrl, token };
}
