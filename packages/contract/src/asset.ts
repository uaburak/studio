import { z } from "zod";
import { AssetAnalysis } from "./asset-analysis.ts";
import { EntityId, PageQuery, pageOf, Timestamp, TrashFilter } from "./common.ts";

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
    /**
     * Set while the file is in the trash: `POST /api/assets/{id}/restore` brings it back;
     * `TRASH_RETENTION_DAYS` later it is purged (row and stored bytes). Its bytes are still served
     * meanwhile (old chat messages keep showing it). Absent from older servers (= not deleted).
     */
    deletedAt: Timestamp.nullable().optional(),
    /**
     * What Vision read in a picture (N12): Turkish tags, text, colours, shape. Null until the
     * worker analysed it; absent from older servers and from upload responses.
     */
    analysis: AssetAnalysis.nullable().optional(),
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
  /** Trashed files: left out by default (`exclude`). */
  deleted: TrashFilter.optional(),
  /**
   * Search (N12): every word must appear in the file name, kind, Turkish tags (or Vision's English
   * identifiers), the text read on the picture, its colours or the AI caption. Turkish-insensitive.
   */
  q: z.string().trim().max(200).optional(),
});
export type AssetListQuery = z.input<typeof AssetListQuery>;

export const AssetList = pageOf(Asset, "AssetList");
export type AssetList = z.infer<typeof AssetList>;

// --- where a file is used (delete safety) ---------------------------------------------

/**
 * Where an asset is used:
 * - `version`: a post version's rendered slide (what gets published);
 * - `editor_document`: a version's canvas document (Wecra bundle);
 * - `slide`: pictured in a version's slide design (`/media/<id>` in its HTML);
 * - `product`: a product photo; `brand_kit`: a logo, font or sample post of the brand kit;
 * - `conversation`: attached in a chat (does not block deleting; the chat keeps a broken picture
 *   once the file is purged);
 * - `template`: a brand template's preview, document or picture (N9).
 */
export const AssetUsageKind = z
  .enum(["version", "editor_document", "slide", "product", "brand_kit", "conversation", "template"])
  .meta({ id: "AssetUsageKind" });
export type AssetUsageKind = z.infer<typeof AssetUsageKind>;

/** Usages that refuse a delete (409): the file would vanish from a post, a product or the kit. */
export const BLOCKING_ASSET_USAGES = [
  "version",
  "editor_document",
  "slide",
  "product",
  "brand_kit",
  "template",
] as const satisfies readonly AssetUsageKind[];

export const AssetUsage = z
  .object({
    kind: AssetUsageKind,
    /** True when this use refuses the delete. */
    blocking: z.boolean(),
    /** Turkish, e.g. "“Kış kampanyası” v3, 2. kare". */
    label: z.string(),
    contentId: EntityId.nullable().default(null),
    version: z.number().int().min(1).nullable().default(null),
    productId: EntityId.nullable().default(null),
    conversationId: EntityId.nullable().default(null),
  })
  .meta({ id: "AssetUsage" });
export type AssetUsage = z.infer<typeof AssetUsage>;

export const AssetUsageList = z
  .object({
    assetId: EntityId,
    usages: z.array(AssetUsage),
    /** No blocking usage: `DELETE /api/assets/{id}` will move it to the trash. */
    deletable: z.boolean(),
  })
  .meta({ id: "AssetUsageList" });
export type AssetUsageList = z.infer<typeof AssetUsageList>;

// --- thumbnails ------------------------------------------------------------------------

/**
 * Widths `GET /api/assets/{id}/thumbnail?w=` produces; a requested width is rounded up to the
 * next one (the largest caps it), so each picture has at most this many cached sizes.
 */
export const THUMBNAIL_WIDTHS = [160, 240, 320, 480, 640, 960, 1280] as const;

export function thumbnailWidth(requested: number): number {
  const w = Number.isFinite(requested) ? requested : 480;
  return THUMBNAIL_WIDTHS.find((t) => t >= w) ?? 1280;
}

/** Image types the thumbnail endpoint resizes (others answer 415). */
export const THUMBNAILABLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const AssetThumbnailQuery = z.object({
  /** Wanted width in px (CSS width × device pixel ratio); rounded up to THUMBNAIL_WIDTHS. */
  w: z.coerce.number().int().min(1).max(4096).default(480),
});
export type AssetThumbnailQuery = z.input<typeof AssetThumbnailQuery>;

/** `<img src>` path of an asset's thumbnail (same origin). */
export function assetThumbnailPath(assetId: string, width: number): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${thumbnailWidth(width)}`;
}

// --- similar pictures ("Benzerleri", N12) ------------------------------------------------------

export const AssetSimilarQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type AssetSimilarQuery = z.input<typeof AssetSimilarQuery>;

export const AssetSimilarItem = z
  .object({
    asset: Asset,
    /** Vision feature-print distance (0 = the same picture; unrelated ones ≈ 1 or more). */
    distance: z.number().min(0),
    /** 0…1 for display. */
    similarity: z.number().min(0).max(1),
  })
  .meta({ id: "AssetSimilarItem" });
export type AssetSimilarItem = z.infer<typeof AssetSimilarItem>;

/** `GET /api/assets/{id}/similar`: the brand's pictures closest to this one, nearest first. */
export const AssetSimilarList = z
  .object({
    assetId: EntityId,
    items: z.array(AssetSimilarItem),
    /** Turkish, when nothing can be compared yet (the picture is not analysed). */
    note: z.string().nullable(),
  })
  .meta({ id: "AssetSimilarList" });
export type AssetSimilarList = z.infer<typeof AssetSimilarList>;

/** `GET /api/worker/assets/analysis/pending`: pictures the worker should read. */
export const AssetAnalysisPendingList = z
  .object({ items: z.array(Asset) })
  .meta({ id: "AssetAnalysisPendingList" });
export type AssetAnalysisPendingList = z.infer<typeof AssetAnalysisPendingList>;
