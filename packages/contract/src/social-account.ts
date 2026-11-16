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

export const MetaDiscoverInput = z
  .object({
    brandId: EntityId,
    userAccessToken: z.string().trim().min(8).max(4096),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    autoConnect: z.boolean().default(true),
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
