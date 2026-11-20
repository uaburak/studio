import {
  allocateMentionSlugs,
  MAX_MENTION_POSTS,
  type MentionCandidate,
  type MentionTarget,
  type MessageEntityMention,
  productPhotoAngle,
  type TurnContent,
  type TurnProduct,
  type TurnProductPhoto,
} from "@studio/contract";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { toBrandProduct, toContent } from "../db/mappers.ts";
import {
  assetAnalyses,
  assets,
  brandProducts,
  contents,
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
} from "../db/schema.ts";
import { pendingCounts } from "./approvals.ts";

/*
 * `@product` / `@post` mention names of a brand (contract mention.ts): derived from the names on
 * every read, products first then posts, both oldest first, so a name stays put while the names
 * do. Trashed posts keep their name (they can come back) but do not resolve.
 */

export interface BrandMentions {
  /** product id -> mention name */
  products: Map<string, string>;
  /** content id -> mention name (trashed posts included) */
  contents: Map<string, string>;
  /** Names that resolve (products and posts not in the trash). */
  targets: MentionTarget[];
}

export async function brandMentions(db: Db, brandId: string): Promise<BrandMentions> {
  const [productRows, contentRows] = await Promise.all([
    db
      .select({ id: brandProducts.id, name: brandProducts.name })
      .from(brandProducts)
      .where(eq(brandProducts.brandId, brandId))
      .orderBy(asc(brandProducts.id)),
    db
      .select({ id: contents.id, name: contents.title, deletedAt: contents.deletedAt })
      .from(contents)
      .where(eq(contents.brandId, brandId))
      .orderBy(asc(contents.id)),
  ]);
  const taken = new Set<string>();
  const products = allocateMentionSlugs(productRows, "product", taken);
  const contentSlugs = allocateMentionSlugs(contentRows, "content", taken);
  const targets: MentionTarget[] = [
    ...productRows.map((p) => ({
      kind: "product" as const,
      id: p.id,
      slug: products.get(p.id) ?? "",
    })),
    ...contentRows
      .filter((c) => c.deletedAt === null)
      .map((c) => ({ kind: "content" as const, id: c.id, slug: contentSlugs.get(c.id) ?? "" })),
  ];
  return { products, contents: contentSlugs, targets };
}

/** The product's mention name (computed with the brand's other names). */
export async function productSlugs(db: Db, brandId: string): Promise<Map<string, string>> {
  return (await brandMentions(db, brandId)).products;
}

/** Products (oldest first) and the newest posts, for the composer's `@` list. */
export async function mentionCandidates(db: Db, brandId: string): Promise<MentionCandidate[]> {
  const names = await brandMentions(db, brandId);
  const productRows = await db
    .select()
    .from(brandProducts)
    .where(eq(brandProducts.brandId, brandId))
    .orderBy(asc(brandProducts.id));
  const postRows = await db
    .select({
      id: contents.id,
      title: contents.title,
      status: contents.status,
      versionId: contents.currentVersionId,
    })
    .from(contents)
    .where(and(eq(contents.brandId, brandId), isNull(contents.deletedAt)))
    .orderBy(desc(contents.id))
    .limit(MAX_MENTION_POSTS);
  const covers = await firstSlides(
    db,
    postRows.flatMap((p) => (p.versionId ? [p.versionId] : [])),
  );
  const pending = await pendingCounts(
    db,
    postRows.map((p) => p.id),
  );
  return [
    ...productRows.map(
      (p): MentionCandidate => ({
        kind: "product",
        id: p.id,
        slug: names.products.get(p.id) ?? "",
        label: p.name,
        imageAssetId: p.imageAssetIds[0] ?? null,
        detail: p.category,
        pendingApprovals: 0,
      }),
    ),
    ...postRows.map(
      (p): MentionCandidate => ({
        kind: "content",
        id: p.id,
        slug: names.contents.get(p.id) ?? "",
        label: p.title,
        imageAssetId: (p.versionId ? covers.get(p.versionId) : null) ?? null,
        detail: p.status,
        pendingApprovals: pending.get(p.id) ?? 0,
      }),
    ),
  ];
}

const CHUNK = 50;

/** version id -> rendered asset of its first slide. */
async function firstSlides(db: Db, versionIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < versionIds.length; i += CHUNK) {
    const rows = await db
      .select({
        versionId: contentVersionSlides.versionId,
        asset: contentVersionSlides.renderedAssetId,
      })
      .from(contentVersionSlides)
      .where(
        and(
          inArray(contentVersionSlides.versionId, versionIds.slice(i, i + CHUNK)),
          eq(contentVersionSlides.position, 0),
        ),
      );
    for (const r of rows) if (r.asset) out.set(r.versionId, r.asset);
  }
  return out;
}

// --- turn context ------------------------------------------------------------------------------

/** Mentioned products with every photo, and mentioned posts (for the agent's turn). */
export async function mentionedEntities(
  db: Db,
  brandId: string | null,
  mentions: readonly MessageEntityMention[],
): Promise<{ products: TurnProduct[]; contents: TurnContent[] }> {
  if (!brandId || mentions.length === 0) return { products: [], contents: [] };
  const firstName = new Map<string, string>();
  for (const m of mentions) if (!firstName.has(m.id)) firstName.set(m.id, m.name);
  const productIds = [...new Set(mentions.filter((m) => m.kind === "product").map((m) => m.id))];
  const contentIds = [...new Set(mentions.filter((m) => m.kind === "content").map((m) => m.id))];
  const names = await brandMentions(db, brandId);

  const products: TurnProduct[] = [];
  if (productIds.length > 0) {
    const rows = await db
      .select()
      .from(brandProducts)
      .where(and(eq(brandProducts.brandId, brandId), inArray(brandProducts.id, productIds)));
    const photoIds = [...new Set(rows.flatMap((r) => r.imageAssetIds))];
    const photoRows = photoIds.length
      ? await db
          .select({ asset: assets, analysis: assetAnalyses })
          .from(assets)
          .leftJoin(assetAnalyses, eq(assetAnalyses.assetId, assets.id))
          .where(inArray(assets.id, photoIds))
      : [];
    const byId = new Map(photoRows.map((r) => [r.asset.id, r]));
    for (const id of productIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      const photos: TurnProductPhoto[] = [];
      row.imageAssetIds.forEach((assetId, position) => {
        const hit = byId.get(assetId);
        if (!hit || hit.asset.deletedAt) return;
        const tags = (hit.analysis?.tags ?? []).map((t) => t.label).slice(0, 12);
        photos.push({
          assetId,
          mimeType: hit.asset.mimeType,
          width: hit.asset.width,
          height: hit.asset.height,
          filename: hit.asset.originalFilename,
          position,
          angleHint: productPhotoAngle(
            hit.asset.originalFilename,
            tags.join(" "),
            hit.analysis?.caption,
          ),
          caption: hit.analysis?.caption ?? null,
          tags,
          text: (hit.analysis?.text ?? "").slice(0, 600),
        });
      });
      products.push({
        mention: firstName.get(id) ?? names.products.get(id) ?? "",
        product: toBrandProduct(row, names.products.get(id)),
        photos,
      });
    }
  }

  const contentsOut: TurnContent[] = [];
  if (contentIds.length > 0) {
    const rows = await db
      .select({
        row: contents,
        current: currentVersionColumns,
        documentKind: contentVersionDocuments.kind,
      })
      .from(contents)
      .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
      .leftJoin(
        contentVersionDocuments,
        eq(contentVersionDocuments.versionId, contents.currentVersionId),
      )
      .where(and(eq(contents.brandId, brandId), inArray(contents.id, contentIds)));
    const pending = await pendingCounts(db, contentIds);
    for (const id of contentIds) {
      const hit = rows.find((r) => r.row.id === id);
      if (!hit) continue;
      contentsOut.push({
        mention: firstName.get(id) ?? names.contents.get(id) ?? "",
        // A canvas post (Wecra document): the agent edits and continues it with its canvas tools.
        canvas: hit.documentKind === "wecra",
        content: toContent(hit.row, hit.current, pending.get(id) ?? 0),
      });
    }
  }
  return { products, contents: contentsOut };
}

const currentVersionColumns = {
  id: contentVersions.id,
  version: contentVersions.version,
  contentHash: contentVersions.contentHash,
};
