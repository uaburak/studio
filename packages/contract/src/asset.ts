import { z } from "zod";
import { EntityId, PageQuery, pageOf, Timestamp } from "./common.ts";

export const AssetKind = z
  .enum(["image", "video", "audio", "document", "font", "logo", "other"])
  .meta({ id: "AssetKind" });
export type AssetKind = z.infer<typeof AssetKind>;

/** Where the file came from: the user, the generation pipeline, or brand ingestion. */
export const AssetSource = z.enum(["upload", "generated", "ingested"]).meta({ id: "AssetSource" });
export type AssetSource = z.infer<typeof AssetSource>;

const MiB = 1024 * 1024;

export interface AssetMimeRule {
  /** Kind assigned when the upload does not name one. */
  defaultKind: AssetKind;
  /** Kinds this mime type may be stored as. */
  kinds: readonly AssetKind[];
  maxBytes: number;
  /** Extension used in the R2 object key. */
  ext: string;
}

/**
 * Upload allow-list. Anything not listed is rejected with 415.
 *
 * Limits are deliberately below the Workers request-body limit because the
 * file is buffered in memory for hashing. Larger media (long Reels footage)
 * will need direct-to-R2 uploads in a later phase.
 */
export const ASSET_MIME_RULES = {
  "image/jpeg": {
    defaultKind: "image",
    kinds: ["image", "logo", "other"],
    maxBytes: 20 * MiB,
    ext: ".jpg",
  },
  "image/png": {
    defaultKind: "image",
    kinds: ["image", "logo", "other"],
    maxBytes: 20 * MiB,
    ext: ".png",
  },
  "image/webp": {
    defaultKind: "image",
    kinds: ["image", "logo", "other"],
    maxBytes: 20 * MiB,
    ext: ".webp",
  },
  "image/gif": { defaultKind: "image", kinds: ["image", "other"], maxBytes: 20 * MiB, ext: ".gif" },
  "image/svg+xml": {
    defaultKind: "logo",
    kinds: ["logo", "image", "other"],
    maxBytes: 2 * MiB,
    ext: ".svg",
  },
  "video/mp4": { defaultKind: "video", kinds: ["video", "other"], maxBytes: 50 * MiB, ext: ".mp4" },
  "video/quicktime": {
    defaultKind: "video",
    kinds: ["video", "other"],
    maxBytes: 50 * MiB,
    ext: ".mov",
  },
  "audio/mpeg": {
    defaultKind: "audio",
    kinds: ["audio", "other"],
    maxBytes: 50 * MiB,
    ext: ".mp3",
  },
  "audio/mp4": { defaultKind: "audio", kinds: ["audio", "other"], maxBytes: 50 * MiB, ext: ".m4a" },
  "audio/x-m4a": {
    defaultKind: "audio",
    kinds: ["audio", "other"],
    maxBytes: 50 * MiB,
    ext: ".m4a",
  },
  "audio/aac": { defaultKind: "audio", kinds: ["audio", "other"], maxBytes: 50 * MiB, ext: ".aac" },
  "audio/wav": { defaultKind: "audio", kinds: ["audio", "other"], maxBytes: 50 * MiB, ext: ".wav" },
  "font/woff2": { defaultKind: "font", kinds: ["font"], maxBytes: 5 * MiB, ext: ".woff2" },
  "font/woff": { defaultKind: "font", kinds: ["font"], maxBytes: 5 * MiB, ext: ".woff" },
  "font/ttf": { defaultKind: "font", kinds: ["font"], maxBytes: 5 * MiB, ext: ".ttf" },
  "font/otf": { defaultKind: "font", kinds: ["font"], maxBytes: 5 * MiB, ext: ".otf" },
  "application/pdf": {
    defaultKind: "document",
    kinds: ["document", "other"],
    maxBytes: 50 * MiB,
    ext: ".pdf",
  },
  /** The post editor's canvas document (`EditorDocument`, a zip bundle). */
  "application/vnd.wecra.document+zip": {
    defaultKind: "document",
    kinds: ["document"],
    maxBytes: 50 * MiB,
    ext: ".wecra",
  },
} as const satisfies Record<string, AssetMimeRule>;

export type AssetMimeType = keyof typeof ASSET_MIME_RULES;

/** Largest file any rule accepts; requests above this are rejected before parsing. */
export const MAX_ASSET_BYTES = Math.max(...Object.values(ASSET_MIME_RULES).map((r) => r.maxBytes));

/** Look up the rule for a (possibly parameterised, any-case) mime type. */
export function assetMimeRule(mimeType: string): AssetMimeRule | undefined {
  const bare = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ASSET_MIME_RULES as Record<string, AssetMimeRule>)[bare];
}

export const Asset = z
  .object({
    id: EntityId,
    brandId: EntityId,
    kind: AssetKind,
    source: AssetSource,
    /** R2 object key inside the MEDIA bucket. */
    objectKey: z.string(),
    mimeType: z.string(),
    bytes: z.number().int().min(0),
    /** Hex SHA-256 of the stored bytes. */
    sha256: z.string(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().positive().nullable(),
    originalFilename: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "Asset" });
export type Asset = z.infer<typeof Asset>;

/**
 * Non-file fields of the `multipart/form-data` upload (`POST /api/assets`).
 * The file itself goes in the `file` field. Dimensions are optional hints
 * the client (or worker) measured; the API does not decode media.
 */
export const AssetUploadFields = z.object({
  brandId: EntityId,
  kind: AssetKind.optional(),
  source: AssetSource.default("upload"),
  width: z.coerce.number().int().positive().max(100_000).optional(),
  height: z.coerce.number().int().positive().max(100_000).optional(),
  durationMs: z.coerce.number().int().positive().optional(),
});
export type AssetUploadFields = z.input<typeof AssetUploadFields>;

export const AssetListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  kind: AssetKind.optional(),
  source: AssetSource.optional(),
});
export type AssetListQuery = z.input<typeof AssetListQuery>;

export const AssetList = pageOf(Asset, "AssetList");
export type AssetList = z.infer<typeof AssetList>;
