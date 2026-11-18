import { type AssetUsage, BLOCKING_ASSET_USAGES } from "@studio/contract";
import { and, eq, like, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { AssetRow } from "../db/mappers.ts";
import {
  brandProducts,
  contents,
  contentTemplateSlides,
  contentTemplates,
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
  conversationAliases,
  conversations,
} from "../db/schema.ts";
import { readBrandKit } from "../routes/brand-kits.ts";

/*
 * Where a stored file is used (delete safety, P7): post versions (rendered slides, canvas
 * documents, pictures named in slide HTML), product photos, the brand kit and chat attachments.
 * A use by a post in the trash is listed but does not block: the post goes away with the purge
 * (the asset purge waits for it, see lib/purge.ts).
 */

const quoted = (title: string) => `“${title}”`;

function versionLabel(title: string, version: number, trashed: boolean, rest = ""): string {
  return `${quoted(title)} v${version}${rest}${trashed ? " (silinmiş post)" : ""}`;
}

type Usage = AssetUsage;

/** Every use of `asset`, blocking ones first. */
export async function assetUsages(
  db: Db,
  bucket: R2Bucket,
  asset: Pick<AssetRow, "id" | "brandId">,
): Promise<Usage[]> {
  const out: Usage[] = [];
  const blocks = (kind: Usage["kind"], trashed: boolean) =>
    !trashed && (BLOCKING_ASSET_USAGES as readonly string[]).includes(kind);

  const versionColumns = {
    contentId: contents.id,
    title: contents.title,
    deletedAt: contents.deletedAt,
    version: contentVersions.version,
  };

  const rendered = await db
    .select({ ...versionColumns, position: contentVersionSlides.position })
    .from(contentVersionSlides)
    .innerJoin(contentVersions, eq(contentVersionSlides.versionId, contentVersions.id))
    .innerJoin(contents, eq(contentVersions.contentId, contents.id))
    .where(eq(contentVersionSlides.renderedAssetId, asset.id));
  const seen = new Set<string>();
  for (const r of rendered) {
    const trashed = r.deletedAt !== null;
    seen.add(`${r.contentId}:${r.version}:${r.position}`);
    out.push({
      kind: "version",
      blocking: blocks("version", trashed),
      label: versionLabel(r.title, r.version, trashed, `, ${r.position + 1}. kare`),
      contentId: r.contentId,
      version: r.version,
      productId: null,
      conversationId: null,
    });
  }

  const documents = await db
    .select(versionColumns)
    .from(contentVersionDocuments)
    .innerJoin(contentVersions, eq(contentVersionDocuments.versionId, contentVersions.id))
    .innerJoin(contents, eq(contentVersions.contentId, contents.id))
    .where(eq(contentVersionDocuments.assetId, asset.id));
  for (const r of documents) {
    const trashed = r.deletedAt !== null;
    out.push({
      kind: "editor_document",
      blocking: blocks("editor_document", trashed),
      label: versionLabel(r.title, r.version, trashed, " tuval belgesi"),
      contentId: r.contentId,
      version: r.version,
      productId: null,
      conversationId: null,
    });
  }

  // Pictures placed in a slide design (`/media/<id>.<ext>`, a reel's cover / footage attributes).
  const pictured = await db
    .select({ ...versionColumns, position: contentVersionSlides.position })
    .from(contentVersionSlides)
    .innerJoin(contentVersions, eq(contentVersionSlides.versionId, contentVersions.id))
    .innerJoin(contents, eq(contentVersions.contentId, contents.id))
    .where(
      and(eq(contents.brandId, asset.brandId), like(contentVersionSlides.html, `%${asset.id}%`)),
    );
  for (const r of pictured) {
    if (seen.has(`${r.contentId}:${r.version}:${r.position}`)) continue;
    const trashed = r.deletedAt !== null;
    out.push({
      kind: "slide",
      blocking: blocks("slide", trashed),
      label: versionLabel(r.title, r.version, trashed, `, ${r.position + 1}. karedeki görsel`),
      contentId: r.contentId,
      version: r.version,
      productId: null,
      conversationId: null,
    });
  }

  // Brand templates (N9): their previews, canvas documents and pictures in their slides.
  const templates = new Map<string, string>();
  for (const t of await db
    .select({ id: contentTemplates.id, name: contentTemplates.name })
    .from(contentTemplateSlides)
    .innerJoin(contentTemplates, eq(contentTemplateSlides.templateId, contentTemplates.id))
    .where(
      and(
        eq(contentTemplates.brandId, asset.brandId),
        or(
          eq(contentTemplateSlides.renderedAssetId, asset.id),
          like(contentTemplateSlides.html, `%${asset.id}%`),
        ),
      ),
    ))
    templates.set(t.id, t.name);
  for (const t of await db
    .select({ id: contentTemplates.id, name: contentTemplates.name })
    .from(contentTemplates)
    .where(eq(contentTemplates.documentAssetId, asset.id)))
    templates.set(t.id, t.name);
  for (const name of templates.values()) {
    out.push({
      kind: "template",
      blocking: true,
      label: `${quoted(name)} şablonu`,
      contentId: null,
      version: null,
      productId: null,
      conversationId: null,
    });
  }

  const products = await db
    .select({ id: brandProducts.id, name: brandProducts.name })
    .from(brandProducts)
    .where(
      and(
        eq(brandProducts.brandId, asset.brandId),
        like(brandProducts.imageAssetIds, `%"${asset.id}"%`),
      ),
    );
  for (const p of products) {
    out.push({
      kind: "product",
      blocking: true,
      label: `${quoted(p.name)} ürün fotoğrafı`,
      contentId: null,
      version: null,
      productId: p.id,
      conversationId: null,
    });
  }

  const kit = await readBrandKit(bucket, asset.brandId);
  const kitUses: string[] = [];
  if (kit.logos.some((l) => l.assetId === asset.id)) kitUses.push("Marka kiti logosu");
  if (kit.fonts.some((f) => f.assetId === asset.id)) kitUses.push("Marka kiti yazı tipi");
  if (kit.samples.some((s) => s.assetId === asset.id)) kitUses.push("Marka kiti örnek postu");
  for (const label of kitUses) {
    out.push({
      kind: "brand_kit",
      blocking: true,
      label,
      contentId: null,
      version: null,
      productId: null,
      conversationId: null,
    });
  }

  const chats = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversationAliases)
    .innerJoin(conversations, eq(conversationAliases.conversationId, conversations.id))
    .where(eq(conversationAliases.assetId, asset.id));
  for (const c of chats) {
    out.push({
      kind: "conversation",
      blocking: false,
      label: c.title.trim() ? `${quoted(c.title)} sohbetinde ek` : "Bir sohbette ek",
      contentId: null,
      version: null,
      productId: null,
      conversationId: c.id,
    });
  }

  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/**
 * Whether anything but a chat attachment still holds the asset: the purge then keeps it. Versions
 * of trashed posts count here (a rendered slide is a foreign key; the post's purge comes first).
 */
export async function assetHeld(
  db: Db,
  bucket: R2Bucket,
  asset: Pick<AssetRow, "id" | "brandId">,
): Promise<boolean> {
  const usages = await assetUsages(db, bucket, asset);
  return usages.some((u) => u.kind !== "conversation");
}
