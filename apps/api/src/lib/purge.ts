import { type PurgeResult, TRASH_RETENTION_DAYS } from "@studio/contract";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { AssetRow } from "../db/mappers.ts";
import {
  assets,
  contents,
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
  conversationAliases,
} from "../db/schema.ts";
import { assetHeld } from "./asset-usage.ts";

/*
 * The trash's end (P7). Posts and files stay in "Silinenler" for TRASH_RETENTION_DAYS; then the
 * purge removes them for good:
 * - a post: its row (versions, slides, documents, check runs and finished schedules cascade) and
 *   the files the pipeline made for it (renders, canvas documents, reel videos and covers named
 *   in its slides) that nothing else uses — a duplicate shares renders, a chat may show one;
 * - a file: its row, its stored bytes and thumbnails, and the chat aliases pointing at it — unless
 *   a post version, a product or the brand kit uses it again (then it waits).
 * Runs from the Hub's alarm (hourly) and `POST /api/maintenance/purge`.
 */

const DAY_MS = 86_400_000;
/** D1 binds at most 100 parameters per statement. */
const CHUNK = 50;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export interface PurgeEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
}

/** R2 key prefix of an asset's cached thumbnails. */
export function thumbnailPrefix(assetId: string): string {
  return `thumbs/${assetId}/`;
}

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Delete an asset's stored bytes and thumbnails; returns how many objects went. */
export async function removeAssetFiles(
  bucket: R2Bucket,
  asset: Pick<AssetRow, "id" | "objectKey">,
): Promise<number> {
  const keys = [asset.objectKey];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({
      prefix: thumbnailPrefix(asset.id),
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (const part of chunks(keys, 1000)) await bucket.delete(part);
  return keys.length;
}

/** Remove an asset for good: its chat aliases, its row, then its files. */
export async function deleteAssetForGood(
  db: Db,
  bucket: R2Bucket,
  asset: AssetRow,
): Promise<number> {
  await db.delete(conversationAliases).where(eq(conversationAliases.assetId, asset.id));
  await db.delete(assets).where(eq(assets.id, asset.id));
  return removeAssetFiles(bucket, asset);
}

/**
 * Hard-delete one post now, with the generated files only it used. Returns what went. The caller
 * decides that the post may go (it is in the trash).
 */
export async function purgeContent(
  db: Db,
  bucket: R2Bucket,
  contentId: string,
): Promise<{ contents: number; assets: number; objects: number }> {
  const row = await db.query.contents.findFirst({ where: eq(contents.id, contentId) });
  if (!row) return { contents: 0, assets: 0, objects: 0 };
  const versionIds = (
    await db
      .select({ id: contentVersions.id })
      .from(contentVersions)
      .where(eq(contentVersions.contentId, contentId))
  ).map((v) => v.id);
  const candidates = new Set<string>();
  for (const ids of chunks(versionIds)) {
    const slides = await db
      .select({ rendered: contentVersionSlides.renderedAssetId, html: contentVersionSlides.html })
      .from(contentVersionSlides)
      .where(inArray(contentVersionSlides.versionId, ids));
    for (const s of slides) {
      if (s.rendered) candidates.add(s.rendered);
      for (const match of s.html.matchAll(UUID)) candidates.add(match[0]);
    }
    const documents = await db
      .select({ assetId: contentVersionDocuments.assetId })
      .from(contentVersionDocuments)
      .where(inArray(contentVersionDocuments.versionId, ids));
    for (const d of documents) candidates.add(d.assetId);
  }

  await db.delete(contents).where(eq(contents.id, contentId));

  let removed = 0;
  let objects = 0;
  for (const ids of chunks([...candidates])) {
    const made = await db
      .select()
      .from(assets)
      .where(
        and(
          inArray(assets.id, ids),
          eq(assets.brandId, row.brandId),
          eq(assets.source, "generated"),
        ),
      );
    for (const asset of made) {
      if (await assetHeld(db, bucket, asset)) continue;
      objects += await deleteAssetForGood(db, bucket, asset);
      removed++;
    }
  }
  return { contents: 1, assets: removed, objects };
}

/**
 * Purge what has been in the trash longer than the retention (bounded per run; the next run
 * continues). A failure on one row is logged and skipped.
 */
export async function purgeTrash(
  env: PurgeEnv,
  db: Db,
  now: Date = new Date(),
  limits: { contents?: number; assets?: number } = {},
): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const result: PurgeResult = { contents: 0, assets: 0, objects: 0 };

  const dueContents = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(isNotNull(contents.deletedAt), lte(contents.deletedAt, cutoff)))
    .limit(limits.contents ?? 20);
  for (const { id } of dueContents) {
    try {
      const done = await purgeContent(db, env.MEDIA, id);
      result.contents += done.contents;
      result.assets += done.assets;
      result.objects += done.objects;
    } catch (error) {
      console.warn(`purge: content ${id} could not be purged`, error);
    }
  }

  const dueAssets = await db
    .select()
    .from(assets)
    .where(and(isNotNull(assets.deletedAt), lte(assets.deletedAt, cutoff)))
    .limit(limits.assets ?? 50);
  for (const asset of dueAssets) {
    try {
      // Used again (a version, a product, the kit): it waits — and a post in the trash that
      // still shows it is purged first.
      if (await assetHeld(db, env.MEDIA, asset)) continue;
      result.objects += await deleteAssetForGood(db, env.MEDIA, asset);
      result.assets++;
    } catch (error) {
      console.warn(`purge: asset ${asset.id} could not be purged`, error);
    }
  }
  return result;
}
