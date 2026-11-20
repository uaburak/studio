import type { ContentTemplate, ContentType, TemplateField } from "@studio/contract";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { brandProducts, contents, contentTemplates } from "../db/schema.ts";
import { badRequest } from "./errors.ts";

/*
 * Brand templates (N9) as the API serves them, and the check that a plan item names a template
 * of its brand and type.
 */

export type TemplateRow = typeof contentTemplates.$inferSelect;

export function toTemplate(
  r: TemplateRow,
  previews: ReadonlyArray<string | null>,
  useCount: number,
): ContentTemplate {
  return {
    id: r.id,
    brandId: r.brandId,
    name: r.name,
    description: r.description,
    kind: r.kind,
    contentType: r.contentType,
    width: r.width,
    height: r.height,
    slideCount: r.slideCount,
    // Stored by this server from validated input; the cast only narrows the JSON column type.
    fields: r.fields as TemplateField[],
    previewAssetIds: [...previews],
    source: { contentId: r.sourceContentId, version: r.sourceVersion, title: r.sourceTitle },
    editorDocument:
      r.documentAssetId && r.documentFormat
        ? { kind: "wecra", assetId: r.documentAssetId, format: r.documentFormat }
        : null,
    useCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** How many posts were made from each template. */
export async function templateUseCounts(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ templateId: contents.templateId, n: count() })
    .from(contents)
    .where(inArray(contents.templateId, [...ids]))
    .groupBy(contents.templateId);
  return new Map(rows.flatMap((r) => (r.templateId ? [[r.templateId, r.n] as const] : [])));
}

/**
 * Plan items naming a template: it must exist, be the plan brand's and be of the item's type
 * (400 otherwise, before a foreign key refuses it).
 */
export async function assertPlanTemplates(
  db: Db,
  brandId: string,
  items: ReadonlyArray<{ templateId?: string | null | undefined; contentType: ContentType }>,
): Promise<void> {
  const ids = [...new Set(items.flatMap((i) => (i.templateId ? [i.templateId] : [])))];
  if (ids.length === 0) return;
  const rows = await db
    .select({
      id: contentTemplates.id,
      brandId: contentTemplates.brandId,
      contentType: contentTemplates.contentType,
    })
    .from(contentTemplates)
    .where(inArray(contentTemplates.id, ids));
  items.forEach((item, i) => {
    if (!item.templateId) return;
    const t = rows.find((r) => r.id === item.templateId);
    const path = `items.${i}.templateId`;
    if (!t)
      throw badRequest(`template ${item.templateId} not found`, [
        { path, message: "unknown template" },
      ]);
    if (t.brandId !== brandId)
      throw badRequest("the template belongs to another brand", [
        { path, message: "template must be of the plan's brand" },
      ]);
    if (t.contentType !== item.contentType)
      throw badRequest(`the template is a ${t.contentType}, the item a ${item.contentType}`, [
        { path, message: `item type must be ${t.contentType}` },
      ]);
  });
}

/** A template row or null. */
export async function findTemplate(db: Db, id: string): Promise<TemplateRow | null> {
  return (
    (await db.query.contentTemplates.findFirst({ where: eq(contentTemplates.id, id) })) ?? null
  );
}

/** The brand's products among `ids` (id -> name); products are hard-deleted, so some may be gone. */
export async function existingProducts(
  db: Db,
  brandId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 50) {
    const rows = await db
      .select({ id: brandProducts.id, name: brandProducts.name })
      .from(brandProducts)
      .where(
        and(eq(brandProducts.brandId, brandId), inArray(brandProducts.id, unique.slice(i, i + 50))),
      );
    for (const r of rows) out.set(r.id, r.name);
  }
  return out;
}

/** Plan items naming products: each must be a product of the plan's brand (400 otherwise). */
export async function assertPlanProducts(
  db: Db,
  brandId: string,
  items: ReadonlyArray<{ productIds?: readonly string[] | null | undefined }>,
): Promise<void> {
  const ids = items.flatMap((i) => i.productIds ?? []);
  if (ids.length === 0) return;
  const found = await existingProducts(db, brandId, ids);
  items.forEach((item, i) => {
    (item.productIds ?? []).forEach((id, j) => {
      if (!found.has(id))
        throw badRequest(`product ${id} is not a product of the plan's brand`, [
          { path: `items.${i}.productIds.${j}`, message: "unknown product of this brand" },
        ]);
    });
  });
}
