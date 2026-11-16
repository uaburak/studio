import { z } from "zod";
import { EntityId, nonEmptyUpdate, PageQuery, Platform, pageOf, Timestamp } from "./common.ts";

/**
 * Connection state of a social account.
 * - `pending`: registered, no credentials yet (the token vault is a later phase).
 * - `connected`: credentials stored and healthy.
 * - `needs_reauth`: credentials expired or revoked; the user must reconnect.
 * - `disabled`: kept for history, never used for publishing.
 *
 * No tokens or secrets live on this entity. The vault (Faz 3) will keep
 * encrypted credentials in a separate table keyed by the account id.
 */
export const SocialAccountStatus = z
  .enum(["pending", "connected", "needs_reauth", "disabled"])
  .meta({ id: "SocialAccountStatus" });
export type SocialAccountStatus = z.infer<typeof SocialAccountStatus>;

export const TokenHealthStatus = z
  .enum(["valid", "expiring_soon", "invalid", "missing_scopes", "unchecked"])
  .meta({ id: "TokenHealthStatus" });
export type TokenHealthStatus = z.infer<typeof TokenHealthStatus>;

const Handle = z.string().trim().min(1).max(100);
const ExternalId = z.string().trim().min(1).max(128);

export const SocialAccount = z
  .object({
    id: EntityId,
    brandId: EntityId,
    platform: Platform,
    /** Display handle, e.g. `@mtmagro` or a page/profile name. */
    handle: z.string(),
    /** Platform-side id (IG user id, FB page id, LinkedIn URN) once known. */
    externalId: z.string().nullable(),
    status: SocialAccountStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    hasToken: z.boolean().optional(),
    tokenExpiresAt: Timestamp.nullable().optional(),
    tokenScopes: z.array(z.string()).optional(),
    tokenHealth: TokenHealthStatus.optional(),
    tokenCheckedAt: Timestamp.nullable().optional(),
  })
  .meta({ id: "SocialAccount" });
export type SocialAccount = z.infer<typeof SocialAccount>;

export const SocialAccountCreate = z
  .object({
    brandId: EntityId,
    platform: Platform,
    handle: Handle,
    externalId: ExternalId.nullable().optional(),
    status: SocialAccountStatus.default("pending"),
  })
  .meta({ id: "SocialAccountCreate" });
export type SocialAccountCreate = z.input<typeof SocialAccountCreate>;

export const SocialAccountUpdate = z
  .object({
    handle: Handle.optional(),
    externalId: ExternalId.nullable().optional(),
    status: SocialAccountStatus.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "SocialAccountUpdate" });
export type SocialAccountUpdate = z.input<typeof SocialAccountUpdate>;

export const SocialAccountListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  platform: Platform.optional(),
  status: SocialAccountStatus.optional(),
});
export type SocialAccountListQuery = z.input<typeof SocialAccountListQuery>;

export const SocialAccountList = pageOf(SocialAccount, "SocialAccountList");
export type SocialAccountList = z.infer<typeof SocialAccountList>;

// --- Token vault & platform connect ------------------------------------------

export const SocialAccountTokenPut = z
  .object({
    accessToken: z.string().trim().min(8).max(4096),
    expiresAt: Timestamp.nullable().optional(),
    scopes: z.array(z.string().max(128)).max(64).optional(),
    externalId: ExternalId.optional(),
    handle: Handle.optional(),
  })
  .meta({ id: "SocialAccountTokenPut" });
export type SocialAccountTokenPut = z.input<typeof SocialAccountTokenPut>;

export const MetaDiscoveredPage = z
  .object({
    pageId: z.string(),
    pageName: z.string(),
    canPublish: z.boolean(),
    pageAccessToken: z.string().optional(),
    instagram: z
      .object({
        igUserId: z.string(),
        username: z.string(),
      })
      .nullable(),
  })
  .meta({ id: "MetaDiscoveredPage" });
export type MetaDiscoveredPage = z.infer<typeof MetaDiscoveredPage>;

/** Which discovered Page (and its linked Instagram account) to connect to the brand. */
export const MetaPageSelection = z
  .object({
    pageId: z.string().trim().min(1).max(128),
    /** Connect the Facebook Page itself. */
    facebook: z.boolean().default(true),
    /** Connect the Page's linked Instagram professional account (when it has one). */
    instagram: z.boolean().default(true),
  })
  .meta({ id: "MetaPageSelection" });
export type MetaPageSelection = z.input<typeof MetaPageSelection>;

export const MetaDiscoverInput = z
  .object({
    brandId: EntityId,
    userAccessToken: z.string().trim().min(8).max(4096),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    autoConnect: z.boolean().default(true),
    /**
     * Connect only these Pages / Instagram accounts (when `autoConnect`). Omitted =
     * every Page the user can publish to (the old behaviour).
     */
    selections: z.array(MetaPageSelection).max(100).optional(),
    /**
     * Expiry of `userAccessToken` when the caller already exchanged it (see
     * `POST /api/social-accounts/meta/exchange`); recorded on Instagram accounts.
     */
    userTokenExpiresAt: Timestamp.nullable().optional(),
  })
  .meta({ id: "MetaDiscoverInput" });
export type MetaDiscoverInput = z.input<typeof MetaDiscoverInput>;

export const MetaDiscoverResult = z
  .object({
    pages: z.array(MetaDiscoveredPage),
    connectedAccounts: z.array(SocialAccount),
  })
  .meta({ id: "MetaDiscoverResult" });
export type MetaDiscoverResult = z.infer<typeof MetaDiscoverResult>;

export const LinkedInConnectInput = z
  .object({
    brandId: EntityId,
    handle: Handle,
    personUrn: ExternalId,
    accessToken: z.string().trim().min(8).max(4096),
    expiresInSeconds: z.number().int().positive().optional(),
  })
  .meta({ id: "LinkedInConnectInput" });
export type LinkedInConnectInput = z.input<typeof LinkedInConnectInput>;

// --- OAuth code exchange (Mac connect flow) -----------------------------------

/**
 * Facebook Login result handed over by the Mac (loopback redirect). Either the
 * authorization `code` (needs `appSecret`) or an implicit-flow `accessToken`.
 * The API exchanges it for a long-lived user token when `appSecret` is given.
 */
export const MetaExchangeInput = z
  .object({
    appId: z.string().trim().min(1).max(64),
    appSecret: z.string().trim().min(1).max(256).optional(),
    code: z.string().trim().min(1).max(4096).optional(),
    redirectUri: z.string().url().max(2000).optional(),
    accessToken: z.string().trim().min(8).max(4096).optional(),
  })
  .refine(
    (v) => v.code !== undefined || v.accessToken !== undefined,
    "code or accessToken is required",
  )
  .refine(
    (v) => v.code === undefined || (v.appSecret !== undefined && v.redirectUri !== undefined),
    {
      message: "exchanging a code needs appSecret and redirectUri",
      path: ["code"],
    },
  )
  .meta({ id: "MetaExchangeInput" });
export type MetaExchangeInput = z.input<typeof MetaExchangeInput>;

export const MetaExchangeResult = z
  .object({
    /** The user token to pass to `meta/discover` (kept in memory by the Mac only). */
    userAccessToken: z.string(),
    expiresAt: Timestamp.nullable(),
    /** True when exchanged for a ~60-day token (an App Secret was given). */
    longLived: z.boolean(),
    grantedScopes: z.array(z.string()),
    missingScopes: z.array(z.string()),
    pages: z.array(MetaDiscoveredPage),
  })
  .meta({ id: "MetaExchangeResult" });
export type MetaExchangeResult = z.infer<typeof MetaExchangeResult>;

/** LinkedIn authorization-code exchange: the API swaps the code, reads the member and vaults the token. */
export const LinkedInOAuthInput = z
  .object({
    brandId: EntityId,
    clientId: z.string().trim().min(1).max(128),
    clientSecret: z.string().trim().min(1).max(256),
    code: z.string().trim().min(1).max(4096),
    redirectUri: z.string().url().max(2000),
  })
  .meta({ id: "LinkedInOAuthInput" });
export type LinkedInOAuthInput = z.input<typeof LinkedInOAuthInput>;

/**
 * Body of `POST /api/social-accounts/{id}/check`. With `live` the API asks the
 * platform (Meta `debug_token`, LinkedIn `userinfo`); the App ID/secret come
 * from the Mac's Keychain and are never stored by the API.
 */
export const SocialAccountCheckInput = z
  .object({
    live: z.boolean().default(false),
    appId: z.string().trim().min(1).max(64).optional(),
    appSecret: z.string().trim().min(1).max(256).optional(),
  })
  .meta({ id: "SocialAccountCheckInput" });
export type SocialAccountCheckInput = z.input<typeof SocialAccountCheckInput>;

/** Token health in words the owner can act on (shown per account). */
export const TOKEN_HEALTH_HINTS: Record<TokenHealthStatus, string> = {
  valid: "Bağlantı sağlıklı.",
  expiring_soon: "Erişim anahtarı yakında doluyor; hesabı yeniden bağlayın.",
  invalid: "Erişim anahtarı geçersiz ya da süresi doldu; hesabı yeniden bağlayın.",
  missing_scopes:
    "Yayın için gereken izinlerden bazıları verilmemiş; yeniden bağlarken tüm izinleri onaylayın.",
  unchecked: "Henüz denetlenmedi.",
};
