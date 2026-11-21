import { z } from "zod";
import { AgentEffort, AgentModel, EntityId, Timestamp } from "./common.ts";

/*
 * Mac host settings bridge (iOS Ayarlar parity). Some settings live only in the Mac app's main
 * process (`desktop-settings.json`, the Keychain-sealed secret files): local network access,
 * remote access and its hostname / tunnel token, keeping the Mac awake, the login item, macOS
 * notifications, the Mac's theme and name, the default chat model, the worker's keys and the
 * Meta / LinkedIn app credentials. A paired phone cannot reach the main process, so:
 *
 *   Mac app:  POST /api/host/settings/sync   (127.0.0.1 only, every few seconds)
 *             body: its current non-secret state + the results of changes it applied
 *             answer: the changes queued for it (secret values unsealed, for the Mac only)
 *   phone:    GET  /api/host/settings          (owner: the Mac or a paired device)
 *             the last state the Mac sent, whether it is still syncing, recent changes
 *   phone:    POST /api/host/settings/changes  (owner) queue a change; the Mac applies it
 *
 * Secrets: the phone may set or remove one but never reads it back; the state carries only
 * `saved` (and where it came from). Queued secret values are sealed in the token vault until
 * the Mac picks them up and are erased from the row once the change is finished.
 *
 * Lockout guard: a change that would cut the very route the request came through is refused
 * (409 `conflict`, Turkish message): turning off remote access, changing its address or its
 * token through the tunnel, or turning off local network access through the LAN.
 */

/** The Mac's theme (`desktop-settings.json` → `appearance`). */
export const HostAppearance = z.enum(["system", "light", "dark"]).meta({ id: "HostAppearance" });
export type HostAppearance = z.infer<typeof HostAppearance>;

/** Hostname of the tunnel without scheme or trailing slash ("" = none). */
export const HostTunnelHostname = z
  .string()
  .trim()
  .max(253)
  .transform((v) => v.replace(/^https?:\/\//i, "").replace(/\/+$/, ""))
  .refine((v) => v === "" || /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(v), {
    message: "tunnel hostname looks wrong (studio.example.com)",
  });

/** The non-secret values the phone can see and change. */
export const HostSettingsValues = z
  .object({
    /** LAN gateway + Bonjour ("Yerel ağdan erişim"). */
    lanEnabled: z.boolean(),
    /** Cloudflare Tunnel ("Uzaktan erişim"). */
    remoteControlEnabled: z.boolean(),
    remoteHostname: z.string().max(253),
    /** "Mac'i uyanık tut". */
    keepAwake: z.boolean(),
    /** macOS notifications of the Mac app. */
    notificationsEnabled: z.boolean(),
    appearance: HostAppearance,
    /** The name in the Mac's sidebar ("" = the Claude account's). */
    ownerName: z.string().max(80),
    /** "Mac açılınca Studio'yu başlat" (only the packaged app can register itself). */
    loginItem: z.boolean(),
    /** Default model / effort of new chats on the Mac (null = the app's fallback). */
    defaultModel: z.string().max(64).nullable(),
    defaultEffort: z.string().max(32).nullable(),
    /** Meta App ID / LinkedIn Client ID (not secret; the secrets are keys below). */
    metaAppId: z.string().max(64),
    linkedInClientId: z.string().max(128),
  })
  .meta({ id: "HostSettingsValues" });
export type HostSettingsValues = z.infer<typeof HostSettingsValues>;

/** Keys the phone may set or remove on the Mac (values never come back). */
export const HostKeyName = z
  .enum([
    "CLOUDFLARE_TUNNEL_TOKEN",
    "GEMINI_API_KEY",
    "ELEVENLABS_API_KEY",
    "STUDIO_ELEVENLABS_VOICE_ID",
    "STUDIO_CLOUD_PUBLISHER_URL",
    "STUDIO_CLOUD_PUBLISHER_TOKEN",
    "META_APP_SECRET",
    "LINKEDIN_CLIENT_SECRET",
  ])
  .meta({ id: "HostKeyName" });
export type HostKeyName = z.infer<typeof HostKeyName>;

export const HostKeyState = z
  .object({
    name: HostKeyName,
    /** Turkish label ("ElevenLabs API anahtarı (Reels seslendirme)"). */
    label: z.string().max(120),
    /** Where it belongs on screen. */
    group: z.enum(["tunnel", "worker", "accounts"]),
    /** False for plain values (a voice id, an address); they are still never sent back. */
    secret: z.boolean(),
    saved: z.boolean(),
    /** `env-file`: from the repo's `.env` (dev builds); `settings`: saved in Studio. */
    source: z.enum(["settings", "env-file"]).nullable(),
  })
  .meta({ id: "HostKeyState" });
export type HostKeyState = z.infer<typeof HostKeyState>;

/** Read-only facts about the Mac host (Ayarlar → Gelişmiş / Hakkında). */
export const HostInfo = z
  .object({
    macName: z.string().max(120),
    appVersion: z.string().max(40),
    mode: z.enum(["dev", "packaged"]),
    /** This app runs the API and the worker (false: attached to another Studio server). */
    hostEnabled: z.boolean(),
    /** Turkish one-liner ("Çalışıyor", "Hata: …"). */
    hostStatus: z.string().max(300),
    hostError: z.boolean(),
    apiPort: z.number().int().nullable(),
    lanPort: z.number().int().nullable(),
    lanUrls: z.array(z.string().max(200)).max(8),
    tunnel: z.object({
      state: z.enum(["off", "ok", "warn", "fail"]),
      detail: z.string().max(500),
    }),
    loginItemSupported: z.boolean(),
    loginItemNote: z.string().max(300),
    keepAwakeActive: z.boolean(),
    keepAwakeReason: z.string().max(200).nullable(),
    /** False: no Keychain access, worker keys are plain 0600 files. */
    keysSealed: z.boolean(),
    updatesNote: z.string().max(300),
  })
  .meta({ id: "HostInfo" });
export type HostInfo = z.infer<typeof HostInfo>;

/** What the Mac app sends on every sync. */
export const HostSettingsState = z
  .object({
    values: HostSettingsValues,
    keys: z.array(HostKeyState).max(16),
    info: HostInfo,
  })
  .meta({ id: "HostSettingsState" });
export type HostSettingsState = z.infer<typeof HostSettingsState>;

/** Values a change may set (only the fields sent change). */
export const HostSettingsPatch = z
  .object({
    lanEnabled: z.boolean().optional(),
    remoteControlEnabled: z.boolean().optional(),
    remoteHostname: HostTunnelHostname.optional(),
    keepAwake: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    appearance: HostAppearance.optional(),
    ownerName: z.string().trim().max(80).optional(),
    loginItem: z.boolean().optional(),
    defaultModel: AgentModel.optional(),
    defaultEffort: AgentEffort.optional(),
    metaAppId: z.string().trim().max(64).regex(/^\d*$/, "Meta App ID is digits only").optional(),
    linkedInClientId: z.string().trim().max(128).regex(/^\S*$/, "client id has spaces").optional(),
    /**
     * Not a value but an action: restart the Studio server once after the rest is applied (new
     * worker keys take effect; running jobs are interrupted and retried).
     */
    restartHost: z.literal(true).optional(),
  })
  .meta({ id: "HostSettingsPatch" });
export type HostSettingsPatch = z.infer<typeof HostSettingsPatch>;

/** Set (`value`) or remove (`value: null`) one key. */
export const HostKeyChange = z
  .object({
    name: HostKeyName,
    value: z.string().trim().min(1).max(4096).nullable(),
  })
  .meta({ id: "HostKeyChange" });
export type HostKeyChange = z.infer<typeof HostKeyChange>;

/** `POST /api/host/settings/changes`. */
export const HostSettingsChangeCreate = z
  .object({
    values: HostSettingsPatch.default({}),
    keys: z.array(HostKeyChange).max(8).default([]),
  })
  .refine((c) => Object.keys(c.values).length > 0 || c.keys.length > 0, {
    message: "nothing to change",
  })
  .meta({ id: "HostSettingsChangeCreate" });
export type HostSettingsChangeCreate = z.input<typeof HostSettingsChangeCreate>;

export const HostSettingsChangeStatus = z
  .enum(["pending", "applied", "failed"])
  .meta({ id: "HostSettingsChangeStatus" });
export type HostSettingsChangeStatus = z.infer<typeof HostSettingsChangeStatus>;

/** A queued change as everyone sees it (key values never). */
export const HostSettingsChange = z
  .object({
    id: EntityId,
    values: HostSettingsPatch,
    keys: z.array(z.object({ name: HostKeyName, action: z.enum(["set", "remove"]) })),
    /** The paired device that asked (null: the Mac itself). */
    deviceId: z.string().nullable(),
    status: HostSettingsChangeStatus,
    /** Turkish note from the Mac (why it failed, what it restarted). */
    message: z.string().max(500).nullable(),
    createdAt: Timestamp,
    finishedAt: Timestamp.nullable(),
  })
  .meta({ id: "HostSettingsChange" });
export type HostSettingsChange = z.infer<typeof HostSettingsChange>;

/** Which way the caller reached the API (the lockout guard reads it). */
export const HostRoute = z.enum(["local", "lan", "tunnel"]).meta({ id: "HostRoute" });
export type HostRoute = z.infer<typeof HostRoute>;

/** The Mac counts as syncing when its last sync is this recent. */
export const HOST_SETTINGS_FRESH_MS = 30_000;

/** `GET /api/host/settings`. */
export const HostSettingsView = z
  .object({
    /** The last state the Mac app sent (null: it never did, e.g. an older Mac app). */
    state: HostSettingsState.nullable(),
    /** When the Mac app last synced. */
    seenAt: Timestamp.nullable(),
    /** True when the last sync is within `HOST_SETTINGS_FRESH_MS`: changes are applied soon. */
    live: z.boolean(),
    via: HostRoute,
    /** Pending changes and the latest finished ones, newest first. */
    changes: z.array(HostSettingsChange),
  })
  .meta({ id: "HostSettingsView" });
export type HostSettingsView = z.infer<typeof HostSettingsView>;

/** Result of one change the Mac applied. */
export const HostSettingsResult = z
  .object({
    id: EntityId,
    ok: z.boolean(),
    message: z.string().max(500).nullable().default(null),
  })
  .meta({ id: "HostSettingsResult" });
export type HostSettingsResult = z.input<typeof HostSettingsResult>;

/** `POST /api/host/settings/sync` body (Mac only). */
export const HostSettingsSync = z
  .object({
    state: HostSettingsState,
    results: z.array(HostSettingsResult).max(50).default([]),
  })
  .meta({ id: "HostSettingsSync" });
export type HostSettingsSync = z.input<typeof HostSettingsSync>;

/** A change as the Mac receives it: with the key values. */
export const HostSettingsPendingChange = z
  .object({
    id: EntityId,
    values: HostSettingsPatch,
    keys: z.array(HostKeyChange),
    createdAt: Timestamp,
  })
  .meta({ id: "HostSettingsPendingChange" });
export type HostSettingsPendingChange = z.infer<typeof HostSettingsPendingChange>;

/** `POST /api/host/settings/sync` answer. */
export const HostSettingsSyncResult = z
  .object({ pending: z.array(HostSettingsPendingChange) })
  .meta({ id: "HostSettingsSyncResult" });
export type HostSettingsSyncResult = z.infer<typeof HostSettingsSyncResult>;

/** Turkish refusals of the lockout guard (also used by the apps to explain beforehand). */
export const HOST_LOCKOUT_MESSAGES = {
  tunnel:
    "Bu değişiklik, telefonun şu an kullandığı uzaktan erişim bağlantısını keser. Aynı Wi-Fi'deyken (yerel ağdan) ya da Mac'te değiştir.",
  lan: "Telefon Mac'e şu an yerel ağdan bağlı; yerel ağ erişimini kapatırsan bağlantı kesilir. Uzaktan erişim üzerinden ya da Mac'te kapat.",
} as const;
