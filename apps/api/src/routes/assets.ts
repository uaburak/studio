import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  Asset,
  AssetKind,
  AssetList,
  AssetListQuery,
  AssetSource,
  AssetThumbnailQuery,
  AssetUploadFields,
  AssetUsageList,
  assetMimeRule,
  EntityId,
  MAX_ASSET_BYTES,
  THUMBNAILABLE_MIME_TYPES,
  thumbnailWidth,
} from "@studio/contract";
import { and, desc, eq, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toAsset } from "../db/mappers.ts";
import { assets } from "../db/schema.ts";
import { assetUsages } from "../lib/asset-usage.ts";
import { ApiProblem, badRequest, notFound, validationProblem } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { thumbnailPrefix } from "../lib/purge.ts";
import { createRouter, errors, IdParams, json } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

const tags = ["Assets"];

/** Multipart framing overhead allowed on top of the largest file. */
const MULTIPART_SLACK = 64 * 1024;

export async function requireAsset(db: Db, id: string) {
  const row = await db.query.assets.findFirst({ where: eq(assets.id, id) });
  if (!row) throw notFound("asset", id);
  return row;
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  "application/pdf": (b) => ascii(b, 0, 5) === "%PDF-",
  "image/svg+xml": (b) => /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 4096))),
  // A Wecra document bundle is a zip.
  "application/vnd.wecra.document+zip": (b) =>
    b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
};

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

/**
 * Cheap content sniffing for the types browsers render inline, so a file
 * cannot pose as an image. Media and font containers are not checked.
 */
function contentMatches(mime: string, bytes: Uint8Array): boolean {
  const check = MAGIC[mime];
  return check ? check(bytes) : true;
}

/**
 * Parse a single-range `Range: bytes=...` header against the object size.
 * Returns null to serve the whole file (no header, multi-range or a unit we
 * do not support), or "unsatisfiable" for 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 6266 `filename*` so non-ASCII names (Turkish) survive. */
function contentDisposition(filename: string | null): string {
  if (!filename) return "inline";
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const UploadForm = z.object({
  file: z
    .string()
    .meta({ format: "binary", description: "The file. Allowed types: see ASSET_MIME_RULES." }),
  brandId: EntityId,
  kind: AssetKind.optional(),
  source: AssetSource.optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
});

const router = createRouter();

// POST /api/assets is a plain handler (multipart bodies with a File are not
// expressible as a zod validator); it is documented through the registry.
router.openAPIRegistry.registerPath({
  method: "post",
  path: "/api/assets",
  tags,
  summary: "Upload an asset (multipart/form-data)",
  description:
    "Stores the file in R2 and records its metadata. Enforces the mime allow-list " +
    "(415) and per-type size limits (413).",
  request: {
    body: { required: true, content: { "multipart/form-data": { schema: UploadForm } } },
  },
  responses: {
    201: json(Asset, "Stored."),
    400: errors[400],
    404: errors[404],
    413: json(ApiErrorBody, "File too large (`payload_too_large`)."),
    415: json(ApiErrorBody, "Type not allowed (`unsupported_media_type`)."),
  },
});

router.post("/api/assets", async (c) => {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_ASSET_BYTES + MULTIPART_SLACK) {
    throw new ApiProblem("payload_too_large", `request exceeds ${MAX_ASSET_BYTES} bytes`);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest("expected a multipart/form-data body");
  }

  const file = form.get("file");
  if (file === null || typeof file === "string") {
    throw badRequest("missing file", [{ path: "file", message: "a file field is required" }]);
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key !== "file" && typeof value === "string") fields[key] = value;
  }
  const parsed = AssetUploadFields.safeParse(fields);
  if (!parsed.success) throw validationProblem(parsed.error, "form fields");
  const input = parsed.data;

  const mimeType = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  const rule = assetMimeRule(mimeType);
  if (!rule) {
    throw new ApiProblem(
      "unsupported_media_type",
      `file type "${mimeType || "unknown"}" is not allowed`,
    );
  }
  const kind = input.kind ?? rule.defaultKind;
  if (!rule.kinds.includes(kind)) {
    throw badRequest(`a ${mimeType} file cannot be stored as kind "${kind}"`, [
      { path: "kind", message: `allowed: ${rule.kinds.join(", ")}` },
    ]);
  }
  if (file.size === 0) throw badRequest("file is empty", [{ path: "file", message: "empty" }]);
  if (file.size > rule.maxBytes) {
    throw new ApiProblem(
      "payload_too_large",
      `${mimeType} files are limited to ${rule.maxBytes} bytes (got ${file.size})`,
    );
  }

  const db = createDb(c.env.DB);
  await requireBrand(db, input.brandId);

  const data = await file.arrayBuffer();
  if (!contentMatches(mimeType, new Uint8Array(data, 0, Math.min(data.byteLength, 4096)))) {
    throw new ApiProblem("unsupported_media_type", `file content does not look like ${mimeType}`);
  }
  const sha256 = await sha256Hex(data);
  const id = newId();
  const objectKey = `brands/${input.brandId}/assets/${id}${rule.ext}`;
  const originalFilename = file.name && file.name !== "blob" ? file.name.slice(0, 255) : null;

  await c.env.MEDIA.put(objectKey, data, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { assetId: id, brandId: input.brandId },
    sha256,
  });

  try {
    const [row] = await db
      .insert(assets)
      .values({
        id,
        brandId: input.brandId,
        kind,
        source: input.source,
        objectKey,
        mimeType,
        bytes: file.size,
        sha256,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        originalFilename,
        createdAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return c.json(toAsset(row), 201);
  } catch (err) {
    // Do not leave an orphaned object behind if the metadata write failed.
    await c.env.MEDIA.delete(objectKey).catch(() => undefined);
    throw err;
  }
});

export const assetRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets",
      tags,
      summary: "List assets (newest first)",
      description: "Files in the trash are left out unless `deleted` is `only` or `include`.",
      request: { query: AssetListQuery },
      responses: { 200: json(AssetList, "A page of assets."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, kind, source, deleted } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(assets.brandId, brandId));
      if (kind) where.push(eq(assets.kind, kind));
      if (source) where.push(eq(assets.source, source));
      if (deleted === "only") where.push(isNotNull(assets.deletedAt));
      else if (deleted !== "include") where.push(isNull(assets.deletedAt));
      if (cursor) where.push(lt(assets.id, cursor));
      const rows = await createDb(c.env.DB)
        .select()
        .from(assets)
        .where(and(...where))
        .orderBy(desc(assets.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toAsset, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets/{id}",
      tags,
      summary: "Get asset metadata",
      request: { params: IdParams },
      responses: { 200: json(Asset, "The asset."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireAsset(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toAsset(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets/{id}/content",
      tags,
      summary: "Stream the stored file",
      description:
        "Supports `Range` (206) and `If-None-Match` (304) for media playback and caching.",
      request: { params: IdParams },
      responses: {
        200: {
          description: "The file bytes.",
          content: {
            "application/octet-stream": { schema: z.string().meta({ format: "binary" }) },
          },
        },
        206: { description: "Partial content (Range request)." },
        304: { description: "Not modified." },
        404: errors[404],
        416: { description: "Range not satisfiable." },
      },
    }),
    async (c) => {
      const row = await requireAsset(createDb(c.env.DB), c.req.valid("param").id);
      const reqHeaders = c.req.raw.headers;
      const range = parseRange(reqHeaders.get("range"), row.bytes);
      if (range === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${row.bytes}` },
        });
      }

      const object = await c.env.MEDIA.get(row.objectKey, {
        onlyIf: reqHeaders,
        ...(range ? { range } : {}),
      });
      if (!object) throw notFound("stored object for asset", row.id);

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", row.mimeType);
      headers.set("etag", object.httpEtag);
      headers.set("accept-ranges", "bytes");
      // Objects are immutable (one key per asset id).
      headers.set("cache-control", "private, max-age=31536000, immutable");
      headers.set("content-disposition", contentDisposition(row.originalFilename));
      // Treat stored files as untrusted: no sniffing, no script execution (SVG).
      headers.set("x-content-type-options", "nosniff");
      headers.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );

      if (!("body" in object)) {
        return new Response(null, { status: 304, headers });
      }

      if (range) {
        const last = range.offset + range.length - 1;
        headers.set("content-range", `bytes ${range.offset}-${last}/${object.size}`);
        headers.set("content-length", String(range.length));
        return new Response(object.body, { status: 206, headers });
      }

      headers.set("content-length", String(object.size));
      return new Response(object.body, { status: 200, headers });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets/{id}/usage",
      tags,
      summary: "Where an asset is used",
      description:
        "Post versions (rendered slides, canvas documents, pictures in slide designs), product " +
        "photos, the brand kit and chat attachments, with Turkish labels. Uses by posts in the " +
        "trash and chat attachments do not block a delete.",
      request: { params: IdParams },
      responses: { 200: json(AssetUsageList, "Its uses."), 404: errors[404] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireAsset(db, c.req.valid("param").id);
      const usages = await assetUsages(db, c.env.MEDIA, row);
      return c.json({ assetId: row.id, usages, deletable: !usages.some((u) => u.blocking) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/assets/{id}",
      tags,
      summary: "Move an asset to the trash",
      description:
        "Refused (409 `conflict`, one issue per use) while a post version, a product or the " +
        "brand kit uses it (see `/usage`). The bytes stay served until the purge removes them " +
        "TRASH_RETENTION_DAYS later. Deleting a trashed asset again is a no-op.",
      request: { params: IdParams },
      responses: { 204: { description: "In the trash." }, 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireAsset(db, c.req.valid("param").id);
      if (row.deletedAt) return c.body(null, 204);
      const blocking = (await assetUsages(db, c.env.MEDIA, row)).filter((u) => u.blocking);
      if (blocking.length > 0) {
        throw new ApiProblem(
          "conflict",
          `Dosya kullanılıyor: ${blocking.map((u) => u.label).join(", ")}.`,
          blocking.map((u) => ({ path: `usage.${u.kind}`, message: u.label })),
        );
      }
      await db
        .update(assets)
        .set({ deletedAt: new Date() })
        .where(and(eq(assets.id, row.id), isNull(assets.deletedAt)));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/assets/{id}/restore",
      tags,
      summary: "Take an asset back out of the trash",
      request: { params: IdParams },
      responses: { 200: json(Asset, "Restored."), 404: errors[404] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireAsset(db, c.req.valid("param").id);
      if (!row.deletedAt) return c.json(toAsset(row), 200);
      await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, row.id));
      return c.json(toAsset({ ...row, deletedAt: null }), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets/{id}/thumbnail",
      tags,
      summary: "A resized copy of an image (WebP)",
      description:
        "`w` is rounded up to THUMBNAIL_WIDTHS; the picture is never enlarged. Made once on the " +
        "Mac (the Images binding; locally Miniflare resizes with sharp) and kept in storage " +
        "under `thumbs/`. 415 for files that are not JPEG, PNG, WebP or GIF. When resizing " +
        "fails the original bytes are served (`x-studio-thumbnail: original`, short cache).",
      request: { params: IdParams, query: AssetThumbnailQuery },
      responses: {
        200: {
          description: "The thumbnail (or the original, see above).",
          content: { "image/webp": { schema: z.string().meta({ format: "binary" }) } },
        },
        304: { description: "Not modified." },
        404: errors[404],
        415: json(ApiErrorBody, "Not a picture that can be resized (`unsupported_media_type`)."),
      },
    }),
    async (c) => {
      const row = await requireAsset(createDb(c.env.DB), c.req.valid("param").id);
      if (!(THUMBNAILABLE_MIME_TYPES as readonly string[]).includes(row.mimeType)) {
        throw new ApiProblem(
          "unsupported_media_type",
          `${row.mimeType} files have no thumbnail; use /content`,
        );
      }
      const width = thumbnailWidth(c.req.valid("query").w);
      const key = `${thumbnailPrefix(row.id)}w${width}.webp`;
      const etagOf = (value: string) => `"${row.id}-w${width}-${value}"`;
      const thumbHeaders = (etag: string) => {
        const headers = new Headers({
          "content-type": "image/webp",
          etag,
          // A thumbnail of an asset never changes (assets are immutable).
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        return headers;
      };

      const cached = await c.env.MEDIA.get(key);
      if (cached) {
        const etag = etagOf(cached.etag);
        if (c.req.header("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: thumbHeaders(etag) });
        }
        return new Response(cached.body, { status: 200, headers: thumbHeaders(etag) });
      }

      const original = await c.env.MEDIA.get(row.objectKey);
      if (!original) throw notFound("stored object for asset", row.id);
      try {
        const result = await c.env.IMAGES.input(original.body)
          .transform({ width, fit: "scale-down" })
          .output({ format: "image/webp", quality: 80 });
        if (!result.contentType().startsWith("image/")) {
          throw new Error(`unexpected thumbnail type ${result.contentType()}`);
        }
        const bytes = await result.response().arrayBuffer();
        if (bytes.byteLength === 0) throw new Error("empty thumbnail");
        const stored = await c.env.MEDIA.put(key, bytes, {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: { assetId: row.id, width: String(width) },
        });
        return new Response(bytes, { status: 200, headers: thumbHeaders(etagOf(stored.etag)) });
      } catch (error) {
        console.warn(`api: thumbnail of asset ${row.id} failed; serving the original`, error);
        const again = await c.env.MEDIA.get(row.objectKey);
        if (!again) throw notFound("stored object for asset", row.id);
        return new Response(again.body, {
          status: 200,
          headers: {
            "content-type": row.mimeType,
            "cache-control": "private, max-age=60",
            "x-content-type-options": "nosniff",
            "x-studio-thumbnail": "original",
          },
        });
      }
    },
  );
