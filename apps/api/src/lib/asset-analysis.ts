import {
  ASSET_ANALYSIS_VERSION,
  type Asset,
  type AssetAnalysis,
  AssetOrientation,
  type AssetSimilarItem,
  assetMatchesQuery,
  decodeFeaturePrint,
  featureDistance,
  featureSimilarity,
} from "@studio/contract";
import { and, eq, inArray, isNull, like, lt, or, type SQL, sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { type AssetRow, toAsset } from "../db/mappers.ts";
import { assetAnalyses, assets, jobs } from "../db/schema.ts";
import { createJob } from "../routes/jobs.ts";

/*
 * Media tagging and search (N12): what Vision read in a picture, the search over it, "Benzerleri"
 * and which pictures still wait to be read. The worker reads them (`media.analyze`) and stores the
 * result with PUT /api/worker/assets/{id}/analysis.
 */

export type AssetAnalysisRow = typeof assetAnalyses.$inferSelect;

/** Pictures Vision can read (the helper decodes these; SVG and video are left out). */
export const ANALYZABLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
const ANALYZABLE_KINDS = ["image", "logo"] as const;

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 80;

export function isAnalyzable(row: Pick<AssetRow, "kind" | "mimeType">): boolean {
  return (
    (ANALYZABLE_KINDS as readonly string[]).includes(row.kind) &&
    (ANALYZABLE_MIME_TYPES as readonly string[]).includes(row.mimeType)
  );
}

export function toAssetAnalysis(row: AssetAnalysisRow): AssetAnalysis {
  const orientation = AssetOrientation.safeParse(row.orientation);
  return {
    status: row.status,
    tags: row.tags,
    text: row.text,
    colors: row.colors,
    orientation: orientation.success ? orientation.data : null,
    aspectRatio: row.aspectRatio,
    isCutout: row.isCutout,
    isLogoLike: row.isLogoLike,
    caption: row.caption,
    hasFeaturePrint: Boolean(row.featurePrint),
    note: row.note,
    analyzedAt: row.analyzedAt.toISOString(),
  };
}

/** Analysis columns without the feature print (lists never need it). */
const SUMMARY_COLUMNS = {
  assetId: assetAnalyses.assetId,
  status: assetAnalyses.status,
  version: assetAnalyses.version,
  tags: assetAnalyses.tags,
  text: assetAnalyses.text,
  colors: assetAnalyses.colors,
  orientation: assetAnalyses.orientation,
  aspectRatio: assetAnalyses.aspectRatio,
  isCutout: assetAnalyses.isCutout,
  isLogoLike: assetAnalyses.isLogoLike,
  caption: assetAnalyses.caption,
  featureRevision: assetAnalyses.featureRevision,
  note: assetAnalyses.note,
  helperVersion: assetAnalyses.helperVersion,
  analyzedAt: assetAnalyses.analyzedAt,
  hasPrint: sql<number>`${assetAnalyses.featurePrint} is not null`,
};

type SummaryRow = Omit<AssetAnalysisRow, "featurePrint"> & { hasPrint: number | boolean };

function summaryToAnalysis(row: SummaryRow): AssetAnalysis {
  return toAssetAnalysis({ ...row, featurePrint: row.hasPrint ? "1" : null });
}

/** The analyses of these assets, by asset id. */
export async function loadAnalyses(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, AssetAnalysis>> {
  const out = new Map<string, AssetAnalysis>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rows = await db
      .select(SUMMARY_COLUMNS)
      .from(assetAnalyses)
      .where(inArray(assetAnalyses.assetId, part));
    for (const row of rows) out.set(row.assetId, summaryToAnalysis(row as SummaryRow));
  }
  return out;
}

/** Asset responses with their analysis (null when not analysed yet). */
export async function withAnalyses(db: Db, rows: readonly AssetRow[]): Promise<Asset[]> {
  const analyses = await loadAnalyses(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...toAsset(r), analysis: analyses.get(r.id) ?? null }));
}

export async function assetWithAnalysis(db: Db, row: AssetRow): Promise<Asset> {
  const [asset] = await withAnalyses(db, [row]);
  return asset ?? toAsset(row);
}

/**
 * Search: the filtered rows (newest first) whose name, kind, tags, text, colours or caption hold
 * every word of `q` (Turkish-insensitive). Done in JS so "çiçek" finds "Cicek.jpg" and "ÇİÇEK"
 * alike; a brand's library is small enough (thousands) to scan.
 */
export async function searchAssets(
  db: Db,
  input: { where: SQL[]; q: string; limit: number; cursor?: string | undefined },
): Promise<{ items: Asset[]; nextCursor: string | null }> {
  const where = [...input.where];
  if (input.cursor) where.push(lt(assets.id, input.cursor));
  const out: Asset[] = [];
  let after: string | undefined;
  const BATCH = 400;
  for (;;) {
    const batchWhere = after ? [...where, lt(assets.id, after)] : where;
    const rows = await db
      .select()
      .from(assets)
      .where(and(...batchWhere))
      .orderBy(sql`${assets.id} desc`)
      .limit(BATCH);
    if (rows.length === 0) break;
    const withTags = await withAnalyses(db, rows);
    for (const asset of withTags) {
      if (!assetMatchesQuery(asset, input.q)) continue;
      out.push(asset);
      if (out.length > input.limit) {
        const page = out.slice(0, input.limit);
        return { items: page, nextCursor: page.at(-1)?.id ?? null };
      }
    }
    if (rows.length < BATCH) break;
    after = rows.at(-1)?.id;
  }
  return { items: out, nextCursor: null };
}

/** The brand's pictures closest to `row` by Vision feature print. */
export async function similarAssets(
  db: Db,
  row: AssetRow,
  limit: number,
): Promise<{ items: AssetSimilarItem[]; note: string | null }> {
  const own = await db.query.assetAnalyses.findFirst({
    where: eq(assetAnalyses.assetId, row.id),
  });
  if (!own?.featurePrint) {
    return {
      items: [],
      note: own
        ? "Bu görselin benzerlik izi yok (görsel yardımcı aracı olmadan okunmuş). Yardımcı araç kurulunca yeniden okunur."
        : "Bu görsel henüz okunmadı; birkaç saniye sonra yeniden dene.",
    };
  }
  const target = decodeFeaturePrint(own.featurePrint);
  const candidates = await db
    .select({
      assetId: assetAnalyses.assetId,
      featurePrint: assetAnalyses.featurePrint,
      featureRevision: assetAnalyses.featureRevision,
    })
    .from(assetAnalyses)
    .innerJoin(assets, eq(assets.id, assetAnalyses.assetId))
    .where(
      and(
        eq(assets.brandId, row.brandId),
        isNull(assets.deletedAt),
        sql`${assetAnalyses.featurePrint} is not null`,
        sql`${assets.id} <> ${row.id}`,
      ),
    );
  const scored: { id: string; distance: number }[] = [];
  for (const c of candidates) {
    if (!c.featurePrint || c.featureRevision !== own.featureRevision) continue;
    const distance = featureDistance(target, decodeFeaturePrint(c.featurePrint));
    if (Number.isFinite(distance)) scored.push({ id: c.assetId, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const top = scored.slice(0, limit);
  if (top.length === 0) {
    return { items: [], note: "Karşılaştırılacak başka okunmuş görsel yok." };
  }
  const rows = await db
    .select()
    .from(assets)
    .where(
      inArray(
        assets.id,
        top.map((t) => t.id),
      ),
    );
  const byId = new Map((await withAnalyses(db, rows)).map((a) => [a.id, a]));
  const items: AssetSimilarItem[] = [];
  for (const t of top) {
    const asset = byId.get(t.id);
    if (!asset) continue;
    const distance = Math.round(t.distance * 10_000) / 10_000;
    items.push({ asset, distance, similarity: featureSimilarity(distance) });
  }
  return { items, note: null };
}

/**
 * Pictures waiting to be read: uploads, ingested files and AI images (`ai-image-*`; rendered
 * post slides are left out), not in the trash, with no analysis, an older version, or (when
 * asked) a `partial` one.
 */
function pendingWhere(input: { brandId?: string | undefined; includePartial: boolean }): SQL[] {
  const where: SQL[] = [
    inArray(assets.kind, [...ANALYZABLE_KINDS]),
    inArray(assets.mimeType, [...ANALYZABLE_MIME_TYPES]),
    isNull(assets.deletedAt),
    or(
      inArray(assets.source, ["upload", "ingested"]),
      like(assets.originalFilename, "ai-image-%"),
    ) as SQL,
    or(
      isNull(assetAnalyses.assetId),
      lt(assetAnalyses.version, ASSET_ANALYSIS_VERSION),
      ...(input.includePartial ? [eq(assetAnalyses.status, "partial")] : []),
    ) as SQL,
  ];
  if (input.brandId) where.push(eq(assets.brandId, input.brandId));
  return where;
}

export async function pendingAssets(
  db: Db,
  input: { brandId?: string | undefined; includePartial: boolean; limit: number },
): Promise<AssetRow[]> {
  const rows = await db
    .select({ asset: assets })
    .from(assets)
    .leftJoin(assetAnalyses, eq(assetAnalyses.assetId, assets.id))
    .where(and(...pendingWhere(input)))
    .orderBy(sql`${assets.id} desc`)
    .limit(input.limit);
  return rows.map((r) => r.asset);
}

export async function countPending(
  db: Db,
  input: { brandId?: string | undefined; includePartial: boolean },
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(assets)
    .leftJoin(assetAnalyses, eq(assetAnalyses.assetId, assets.id))
    .where(and(...pendingWhere(input)));
  return Number(row?.n ?? 0);
}

/**
 * Queue a `media.analyze` job unless one is already waiting for this brand (or for every brand).
 * A running job is not enough: it may have read its last batch already. Never throws (an upload
 * must not fail because tagging could not be queued); returns the job id or null.
 */
export async function queueMediaAnalysis(
  env: Env,
  input: {
    brandId?: string | undefined;
    reason: "upload" | "backfill";
    includePartial?: boolean;
  },
): Promise<string | null> {
  try {
    const db = createDb(env.DB);
    const waiting = await db
      .select({ id: jobs.id, brandId: jobs.brandId, payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, "media.analyze"), eq(jobs.status, "queued")))
      .limit(20);
    const covered = waiting.find(
      (j) =>
        (j.brandId === null || j.brandId === (input.brandId ?? null)) &&
        (!input.includePartial || (j.payload as { includePartial?: unknown }).includePartial),
    );
    if (covered) return covered.id;
    const job = await createJob(env, {
      type: "media.analyze",
      ...(input.brandId ? { brandId: input.brandId } : {}),
      payload: { reason: input.reason, includePartial: input.includePartial ?? false },
      // Behind the owner's work; a picture is tagged within seconds on an idle Mac.
      priority: -20,
      maxAttempts: 2,
    });
    return job.id;
  } catch (error) {
    console.warn("api: could not queue media.analyze", error);
    return null;
  }
}
