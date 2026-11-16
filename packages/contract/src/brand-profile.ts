import { z } from "zod";
import {
  EntityId,
  jsonWithin,
  nonEmptyUpdate,
  PageQuery,
  pageOf,
  Timestamp,
  utf8Length,
} from "./common.ts";

/**
 * A brand profile is versioned (PLAN.md §6). Drafts are editable; approving a
 * version freezes it and makes it the brand's single "current" profile.
 * Approving an older approved version again makes it current (rollback).
 */
export const BrandProfileStatus = z.enum(["draft", "approved"]).meta({ id: "BrandProfileStatus" });
export type BrandProfileStatus = z.infer<typeof BrandProfileStatus>;

export const MAX_PROFILE_TEXT_BYTES = 200_000;
export const MAX_PROFILE_TOKENS_BYTES = 200_000;

/** `brand.json` equivalent: colors, fonts, logo variants, spacing, radii, grid. */
export const BrandTokens = z
  .record(z.string(), z.unknown())
  .refine(jsonWithin(MAX_PROFILE_TOKENS_BYTES), "tokens are too large");
export type BrandTokens = z.infer<typeof BrandTokens>;

const ProfileText = z
  .string()
  .refine((s) => utf8Length(s) <= MAX_PROFILE_TEXT_BYTES, "text is too large");

export const ProfileVersion = z.coerce.number().int().min(1);

export const BrandProfile = z
  .object({
    id: EntityId,
    brandId: EntityId,
    /** 1, 2, 3, ... per brand. */
    version: z.number().int().min(1),
    status: BrandProfileStatus,
    /** True for exactly one approved version per brand (or none). */
    isCurrent: z.boolean(),
    tokens: z.record(z.string(), z.unknown()),
    /** `DESIGN.md` equivalent. */
    designRules: z.string(),
    /** `VOICE.md` equivalent. */
    voice: z.string(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    approvedAt: Timestamp.nullable(),
  })
  .meta({ id: "BrandProfile" });
export type BrandProfile = z.infer<typeof BrandProfile>;

export const BrandProfileCreate = z
  .object({
    tokens: BrandTokens.default({}),
    designRules: ProfileText.default(""),
    voice: ProfileText.default(""),
  })
  .meta({ id: "BrandProfileCreate" });
export type BrandProfileCreate = z.input<typeof BrandProfileCreate>;

/** Only drafts can be edited; an approved version is immutable. */
export const BrandProfileUpdate = z
  .object({
    tokens: BrandTokens.optional(),
    designRules: ProfileText.optional(),
    voice: ProfileText.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "BrandProfileUpdate" });
export type BrandProfileUpdate = z.input<typeof BrandProfileUpdate>;

export const BrandProfileListQuery = PageQuery.extend({ status: BrandProfileStatus.optional() });
export type BrandProfileListQuery = z.input<typeof BrandProfileListQuery>;

export const BrandProfileList = pageOf(BrandProfile, "BrandProfileList");
export type BrandProfileList = z.infer<typeof BrandProfileList>;
