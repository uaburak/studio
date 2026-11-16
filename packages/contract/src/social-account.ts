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
