import type { PublishingMode, PublishingStatus } from "@studio/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { publishingSettings } from "../db/schema.ts";
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
  };
}

/** The cloud publisher URL and token for the worker; null when not configured or unreadable. */
export async function cloudCredentials(
  row: PublishingSettingsRow | null,
  env: VaultEnv,
): Promise<{ url: string; token: string } | null> {
  if (!row?.cloudUrl || !row.cloudTokenCiphertext || !row.cloudTokenIv) return null;
  try {
    const token = await decryptSetting(env, CLOUD_TOKEN_SETTING, {
      ciphertext: row.cloudTokenCiphertext,
      iv: row.cloudTokenIv,
      keyVersion: row.cloudTokenKeyVersion,
    });
    return { url: row.cloudUrl, token };
  } catch {
    return null;
  }
}
