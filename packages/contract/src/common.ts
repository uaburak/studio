import { z } from "zod";

/** ISO 8601 timestamp, always UTC (`...Z`). */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * Opaque entity id. The API mints time-ordered UUIDv7 strings, but clients
 * must not parse them; treat ids as opaque.
 */
export const EntityId = z.string().min(1).max(128);
export type EntityId = z.infer<typeof EntityId>;

/** Social platforms Studio produces content for. */
export const Platform = z.enum(["instagram", "facebook", "linkedin"]).meta({ id: "Platform" });
export type Platform = z.infer<typeof Platform>;

// --- Errors ------------------------------------------------------------------

/**
 * Machine-readable error codes. Each maps to exactly one HTTP status
 * (see ERROR_STATUS), so clients can branch on `code` alone.
 */
export const ErrorCode = z
  .enum([
    "validation_error",
    "not_found",
    "conflict",
    "invalid_transition",
    "hash_mismatch",
    "payload_too_large",
    "unsupported_media_type",
    "internal_error",
  ])
  .meta({ id: "ErrorCode" });
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_STATUS = {
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  hash_mismatch: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>;

export const ErrorIssue = z.object({
  /** Dotted path of the offending field, e.g. `slides.0.html`; "" for the root. */
  path: z.string(),
  message: z.string(),
});
export type ErrorIssue = z.infer<typeof ErrorIssue>;

/** The single error shape every API route uses for non-2xx responses. */
export const ApiErrorBody = z
  .object({
    error: z.object({
      code: ErrorCode,
      message: z.string(),
      /** Present for `validation_error`: one entry per failing field. */
      issues: z.array(ErrorIssue).optional(),
    }),
  })
  .meta({ id: "ApiErrorBody", description: "Error response (all non-2xx statuses)." });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// --- Cursor pagination -------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Query parameters shared by every list endpoint. `cursor` is the opaque
 * `nextCursor` from the previous page; omit it for the first page.
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Build a list-response schema: `{ items, nextCursor }` (`null` on the last page). */
export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .meta({ id });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Reject an update body that would change nothing. */
export function nonEmptyUpdate(value: Record<string, unknown>): boolean {
  return Object.values(value).some((v) => v !== undefined);
}

/** UTF-8 byte length (zod's `.max()` counts UTF-16 code units, not bytes). */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Size guard for free-form JSON objects stored as text in D1. */
export function jsonWithin(maxBytes: number) {
  return (value: unknown) => utf8Length(JSON.stringify(value) ?? "") <= maxBytes;
}
