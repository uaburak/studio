import {
  type BrandPlanningSettings,
  effectiveSectorTags,
  historyWindow,
  hookOf,
  istanbulToday,
  MAX_HISTORY_ENTRIES,
  type PlanItemSimilar,
  type PlanningContext,
  type PlanningHistory,
  type PlanningHistoryEntry,
  planItemSimilarities,
  type ReligiousDayOverride,
  SECTOR_TAGS,
  type SectorTag,
  SPECIAL_DAY_CATEGORIES,
  type SpecialDayCategory,
  type SpecialDayList,
  type SpecialDayOverrides,
  specialDaysBetween,
  suggestSectorTags,
} from "@studio/contract";
import { and, desc, eq, gte, inArray, lte, ne, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  appMeta,
  brandPlanningSettings,
  brandProducts,
  brandProfiles,
  brands,
  contentPlans,
  contents,
  type PlanItemSimilarJson,
  planItems,
  schedules,
} from "../db/schema.ts";
import { contentScores, performanceSummary } from "./insights.ts";

/** Days of statistics the plan agent reads (N15). */
const PERFORMANCE_DAYS = 120;

/*
 * Planning context (N5, N6) on the server: the brand's special-day settings (and the tags its
 * profile suggests), the owner's bayram date corrections, the brand's recent history for the plan
 * agent, and the near-duplicate marks stored on plan items.
 */

const OVERRIDES_KEY = "special_days.overrides";
/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

const isTag = (t: string): t is SectorTag => (SECTOR_TAGS as readonly string[]).includes(t);
const isCategory = (c: string): c is SpecialDayCategory =>
  (SPECIAL_DAY_CATEGORIES as readonly string[]).includes(c);

// --- settings -----------------------------------------------------------------------------------

/** Tags guessed from the brand's name, products and current profile. */
async function suggestedTags(db: Db, brandId: string): Promise<SectorTag[]> {
  const [brand, profile, products] = await Promise.all([
    db.query.brands.findFirst({ where: eq(brands.id, brandId) }),
    db.query.brandProfiles.findFirst({
      where: and(eq(brandProfiles.brandId, brandId), eq(brandProfiles.isCurrent, true)),
    }),
    db
      .select({
        name: brandProducts.name,
        category: brandProducts.category,
        tags: brandProducts.tags,
        description: brandProducts.description,
      })
      .from(brandProducts)
      .where(eq(brandProducts.brandId, brandId))
      .limit(60),
  ]);
  const facts = profile?.tokens?.facts;
  return suggestSectorTags({
    strong: [
      brand?.name ?? "",
      ...products.flatMap((p) => [p.name, p.category, ...(p.tags ?? [])]),
    ],
    weak: [
      profile?.voice.slice(0, 4_000) ?? "",
      profile?.designRules.slice(0, 2_000) ?? "",
      facts ? JSON.stringify(facts).slice(0, 4_000) : "",
      ...products.map((p) => p.description.slice(0, 300)),
    ],
  });
}

export async function loadPlanningSettings(
  db: Db,
  brandId: string,
): Promise<BrandPlanningSettings> {
  const [row, suggested] = await Promise.all([
    db.query.brandPlanningSettings.findFirst({ where: eq(brandPlanningSettings.brandId, brandId) }),
    suggestedTags(db, brandId),
  ]);
  return {
    brandId,
    sectorTags: (row?.sectorTags ?? []).filter(isTag),
    disabledCategories: (row?.disabledCategories ?? []).filter(isCategory),
    suggestedTags: suggested,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

export async function savePlanningSettings(
  db: Db,
  brandId: string,
  input: { sectorTags: SectorTag[]; disabledCategories: SpecialDayCategory[] },
): Promise<BrandPlanningSettings> {
  const values = {
    sectorTags: input.sectorTags,
    disabledCategories: input.disabledCategories,
    updatedAt: new Date(),
  };
  await db
    .insert(brandPlanningSettings)
    .values({ brandId, ...values })
    .onConflictDoUpdate({ target: brandPlanningSettings.brandId, set: values });
  return loadPlanningSettings(db, brandId);
}

// --- bayram date overrides ----------------------------------------------------------------------

export async function loadOverrides(db: Db): Promise<SpecialDayOverrides> {
  const row = await db.query.appMeta.findFirst({ where: eq(appMeta.key, OVERRIDES_KEY) });
  if (!row) return { overrides: [], updatedAt: null };
  try {
    const parsed = JSON.parse(row.value) as SpecialDayOverrides["overrides"];
    return {
      overrides: Array.isArray(parsed) ? parsed : [],
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    return { overrides: [], updatedAt: row.updatedAt.toISOString() };
  }
}

export async function saveOverrides(
  db: Db,
  overrides: ReligiousDayOverride[],
): Promise<SpecialDayOverrides> {
  const list = overrides
    .map((o) => ({
      year: o.year,
      ramazanBayrami: o.ramazanBayrami ?? null,
      kurbanBayrami: o.kurbanBayrami ?? null,
    }))
    .filter((o) => o.ramazanBayrami || o.kurbanBayrami)
    .sort((a, b) => a.year - b.year);
  const now = new Date();
  await db
    .insert(appMeta)
    .values({ key: OVERRIDES_KEY, value: JSON.stringify(list), updatedAt: now })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: JSON.stringify(list), updatedAt: now },
    });
  return { overrides: list, updatedAt: now.toISOString() };
}

// --- special days --------------------------------------------------------------------------------

export async function specialDayList(
  db: Db,
  from: string,
  to: string,
  brandId?: string,
): Promise<SpecialDayList> {
  const [settings, overrides] = await Promise.all([
    brandId ? loadPlanningSettings(db, brandId) : null,
    loadOverrides(db),
  ]);
  const tags = settings ? effectiveSectorTags(settings) : [];
  const disabledCategories = settings?.disabledCategories ?? [];
  return {
    from,
    to,
    tags,
    disabledCategories,
    days: specialDaysBetween(from, to, {
      tags,
      disabledCategories,
      overrides: overrides.overrides,
    }),
  };
}

// --- history ---------------------------------------------------------------------------------------

/** Plans and posts that are not part of the history of a plan being written. */
export interface HistoryExclusion {
  /** The plan itself. */
  planId?: string | null;
  /** Its conversation: open proposals there are replaced, not history. */
  conversationId?: string | null;
}

const dayOf = (at: Date) => istanbulToday(at);

function clip(text: string | null | undefined, max: number): string | null {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First sentence of a brief (what the post says), for the similarity check. */
function briefMessage(brief: string | null | undefined): string | null {
  const first = brief?.split(/(?<=[.!?])\s+/)[0];
  return clip(first, 300);
}

/**
 * The brand's history in `window` (newest first): its posts (published, scheduled, approved,
 * drafts) with topic, pillar, opening line, type and day; items of its other open plans; items of
 * rejected plans and items left out on accepting; posts in the trash.
 */
export async function planningHistory(
  db: Db,
  brandId: string,
  window: { from: string; to: string },
  exclude: HistoryExclusion = {},
): Promise<PlanningHistory> {
  const fromMs = Date.parse(`${window.from}T00:00:00+03:00`);
  // A post made up to four months before the window can still be published in it.
  const postRows = await db
    .select({
      id: contents.id,
      title: contents.title,
      brief: contents.brief,
      caption: contents.caption,
      type: contents.type,
      status: contents.status,
      createdAt: contents.createdAt,
      deletedAt: contents.deletedAt,
    })
    .from(contents)
    .where(
      and(
        eq(contents.brandId, brandId),
        gte(contents.createdAt, new Date(fromMs - 120 * 86_400_000)),
      ),
    )
    .orderBy(desc(contents.id))
    .limit(400);

  const ids = postRows.map((r) => r.id);
  // N15: how each published post did (relative engagement), for the history lines.
  const scores = await contentScores(db, brandId, new Date(fromMs - 120 * 86_400_000));
  const scheduleDay = new Map<string, string>();
  const itemOf = new Map<
    string,
    { date: string | null; pillar: string | null; hook: string | null; planId: string; id: string }
  >();
  for (const part of chunks(ids)) {
    const [scheduleRows, itemRows] = await Promise.all([
      db
        .select({
          contentId: schedules.contentId,
          scheduledAt: schedules.scheduledAt,
          status: schedules.status,
        })
        .from(schedules)
        .where(and(inArray(schedules.contentId, part), ne(schedules.status, "cancelled"))),
      db
        .select({
          id: planItems.id,
          planId: planItems.planId,
          contentId: planItems.contentId,
          date: planItems.date,
          pillar: planItems.pillar,
          hook: planItems.hook,
        })
        .from(planItems)
        .where(inArray(planItems.contentId, part)),
    ]);
    // The published (or else the latest) schedule decides the day.
    for (const s of scheduleRows.sort(
      (a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime(),
    )) {
      if (scheduleDay.has(s.contentId) && s.status !== "published") continue;
      scheduleDay.set(s.contentId, dayOf(s.scheduledAt));
    }
    for (const i of itemRows) {
      if (i.contentId) itemOf.set(i.contentId, i);
    }
  }

  const entries: PlanningHistoryEntry[] = [];
  for (const row of postRows) {
    const item = itemOf.get(row.id);
    if (exclude.planId && item?.planId === exclude.planId) continue;
    const date = scheduleDay.get(row.id) ?? item?.date ?? dayOf(row.createdAt);
    if (date < window.from || date > window.to) continue;
    entries.push({
      kind: row.deletedAt ? "deleted" : "post",
      contentId: row.id,
      planId: item?.planId ?? null,
      planItemId: item?.id ?? null,
      date,
      title: row.title,
      hook: hookOf(row.caption) ?? item?.hook ?? null,
      brief: briefMessage(row.brief),
      pillar: item?.pillar ?? null,
      contentType: row.type,
      status: row.deletedAt ? null : row.status,
      reason: null,
      ...(scores.has(row.id) && !row.deletedAt ? { performance: scores.get(row.id) } : {}),
    });
  }

  // Other plans touching the window: rejected ones, what was left out of accepted ones, and open
  // proposals elsewhere.
  const plans = await db
    .select()
    .from(contentPlans)
    .where(
      and(
        eq(contentPlans.brandId, brandId),
        notInArray(contentPlans.status, ["superseded"]),
        lte(contentPlans.periodStart, window.to),
        gte(contentPlans.periodEnd, window.from),
      ),
    )
    .orderBy(desc(contentPlans.id))
    .limit(40);
  const relevant = plans.filter(
    (p) =>
      p.id !== exclude.planId &&
      !(
        (p.status === "draft" || p.status === "proposed") &&
        exclude.conversationId &&
        p.conversationId === exclude.conversationId
      ),
  );
  for (const part of chunks(relevant.map((p) => p.id))) {
    const items = await db.select().from(planItems).where(inArray(planItems.planId, part));
    for (const item of items) {
      const plan = relevant.find((p) => p.id === item.planId);
      if (!plan) continue;
      let kind: PlanningHistoryEntry["kind"] | null = null;
      if (plan.status === "rejected") kind = "rejected";
      else if (plan.status === "accepted" && item.status === "skipped") kind = "skipped";
      else if (plan.status === "draft" || plan.status === "proposed") kind = "planned";
      if (!kind) continue; // accepted items are their posts (above)
      entries.push({
        kind,
        contentId: null,
        planId: plan.id,
        planItemId: item.id,
        date: item.date,
        title: item.title,
        hook: item.hook,
        brief: briefMessage(item.brief),
        pillar: item.pillar,
        contentType: item.contentType,
        status: null,
        reason: kind === "rejected" ? clip(plan.rejectionReason, 300) : null,
      });
    }
  }

  entries.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return {
    from: window.from,
    to: window.to,
    entries: entries.slice(0, MAX_HISTORY_ENTRIES),
    truncated: entries.length > MAX_HISTORY_ENTRIES,
  };
}

/** What the plan agent reads before planning `periodStart`…`periodEnd` for a brand. */
export async function planningContext(
  db: Db,
  brandId: string,
  period: { periodStart: string; periodEnd: string },
  exclude: HistoryExclusion = {},
): Promise<PlanningContext> {
  const [settings, overrides, history, performance] = await Promise.all([
    loadPlanningSettings(db, brandId),
    loadOverrides(db),
    planningHistory(db, brandId, historyWindow(period.periodStart, period.periodEnd), exclude),
    performanceSummary(db, brandId, PERFORMANCE_DAYS, new Date()),
  ]);
  return {
    brandId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    settings,
    specialDays: specialDaysBetween(period.periodStart, period.periodEnd, {
      tags: effectiveSectorTags(settings),
      disabledCategories: settings.disabledCategories,
      overrides: overrides.overrides,
    }),
    history,
    ...(performance ? { performance } : {}),
  };
}

// --- near-duplicate marks ----------------------------------------------------------------------------

interface MarkableItem {
  id: string;
  title: string;
  hook: string | null;
  brief: string;
  pillar: string | null;
  date: string | null;
  status: string;
}

/**
 * Near-duplicate marks for a plan's items (in their order) against the brand's posts and each
 * other (rejected, left-out and other open plans' items do not count: `countsAsHistory`). Skipped
 * items get none.
 */
export async function similarityMarks(
  db: Db,
  plan: {
    id: string;
    brandId: string;
    conversationId: string | null;
    periodStart: string;
    periodEnd: string;
  },
  items: readonly MarkableItem[],
): Promise<PlanItemSimilarJson[][]> {
  const history = await planningHistory(
    db,
    plan.brandId,
    historyWindow(plan.periodStart, plan.periodEnd),
    { planId: plan.id, conversationId: plan.conversationId },
  );
  const live = items.filter((i) => i.status !== "skipped");
  const marks = planItemSimilarities(
    live.map((i) => ({
      id: i.id,
      title: i.title,
      hook: i.hook,
      brief: i.brief,
      pillar: i.pillar,
      date: i.date,
    })),
    history.entries,
  );
  const byId = new Map(
    live.map((item, i): [string, PlanItemSimilar[]] => [item.id, marks[i] ?? []]),
  );
  return items.map((i) => byId.get(i.id) ?? []);
}

/** Stored form: null when there is nothing to mark. */
export function storedMarks(marks: readonly PlanItemSimilarJson[]): PlanItemSimilarJson[] | null {
  return marks.length > 0 ? [...marks] : null;
}

/** Whether two stored mark lists differ. */
export function marksChanged(
  a: readonly PlanItemSimilarJson[] | null,
  b: readonly PlanItemSimilarJson[] | null,
): boolean {
  return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
}
