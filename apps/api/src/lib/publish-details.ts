/**
 * Publish details of posts (N13) and the brand's known Instagram locations.
 *
 * Details do not touch the approval. Saving them while schedules are pending bumps those
 * schedules' `details_rev`, so the worker pushes their cloud orders again (its push key includes
 * the revision). While a post is publishing or published they are frozen (409).
 */
import { type KnownLocation, PublishDetails } from "@studio/contract";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { publishLocations, schedules } from "../db/schema.ts";

/** Stored details, or null when there are none (or the row is unreadable). */
export function readPublishDetails(raw: unknown): PublishDetails | null {
  if (!raw) return null;
  const parsed = PublishDetails.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Drop empty parts so `{}` means "no details" and the stored JSON stays small. */
export function compactDetails(details: PublishDetails): PublishDetails | null {
  const out: PublishDetails = {};
  const comment = details.firstComment?.trim();
  if (comment) out.firstComment = comment;
  if (details.altTexts?.some((t) => t?.trim())) {
    out.altTexts = details.altTexts.map((t) => (t?.trim() ? t.trim() : null));
    if (details.altTextSources?.length) out.altTextSources = details.altTextSources;
  }
  if (details.location) out.location = details.location;
  if (details.collaborators?.length) out.collaborators = [...new Set(details.collaborators)];
  if (details.userTags?.length) out.userTags = details.userTags;
  if (details.reelCover) out.reelCover = details.reelCover;
  if (details.shareToFeed === false) out.shareToFeed = false;
  return Object.keys(out).length ? out : null;
}

/** Pending schedules of the content: their order (if in the cloud) must be pushed again. */
export function bumpDetailsRevision(db: Db, contentId: string, now: Date) {
  return db
    .update(schedules)
    .set({ detailsRev: sql`${schedules.detailsRev} + 1`, updatedAt: now })
    .where(and(eq(schedules.contentId, contentId), eq(schedules.status, "pending")));
}

/** Remember a location (`used` keeps a `page` / `manual` entry's source, only its time moves). */
export function rememberLocation(
  db: Db,
  brandId: string,
  location: { id: string; name: string },
  source: KnownLocation["source"],
  now: Date,
) {
  return db
    .insert(publishLocations)
    .values({
      brandId,
      locationId: location.id,
      name: location.name,
      source,
      lastUsedAt: source === "used" ? now : null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [publishLocations.brandId, publishLocations.locationId],
      set:
        source === "used"
          ? { lastUsedAt: now }
          : source === "page"
            ? { name: location.name, source: "page" }
            : { name: location.name },
    });
}

/** The brand's Pages first, then by last use, then by name. */
export async function knownLocations(db: Db, brandId: string): Promise<KnownLocation[]> {
  const rows = await db
    .select()
    .from(publishLocations)
    .where(eq(publishLocations.brandId, brandId))
    .orderBy(desc(publishLocations.lastUsedAt), publishLocations.name);
  const order = { page: 0, used: 1, manual: 1 } as const;
  return rows
    .map((r) => ({
      id: r.locationId,
      name: r.name,
      source: r.source,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }))
    .sort((a, b) => order[a.source] - order[b.source]);
}
