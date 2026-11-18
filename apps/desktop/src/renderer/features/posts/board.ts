// The posts board (pure values, tested without views): one card per content item with its
// current version, plan item, schedule and latest generation job; where each post stands;
// the status filters with counts; months, search and keyboard selection. Port of StudioKit's
// PostBoard.swift / PostEditing.swift with the Wecra filter set.
import {
  APPROVABLE_STATUSES,
  type Content,
  type ContentType,
  type ContentVersion,
  computeContentHash,
  isTerminalJobStatus,
  type Job,
  type Plan,
  type PlanItem,
  type Platform,
  type Schedule,
  statusIn,
} from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";
import {
  addMonths,
  localDate,
  type MonthKey,
  monthKeyOf,
  shortDay,
  shortDayTime,
} from "./dates.ts";
import { aspectLabel, slotsIn } from "./slides.ts";

// --- state ------------------------------------------------------------------------------------

export type PostState =
  /** No version yet; a generation job is queued or running. */
  | "generating"
  /** No version yet, nothing running. */
  | "draft"
  /** No version yet and the last generation failed (A3). */
  | "generationFailed"
  /** The design has an empty image slot (or the plan expects the owner's picture). */
  | "imageNeeded"
  /** Has a version and waits for approval. */
  | "ready"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";

export const STATE_LABEL: Record<PostState, string> = {
  generating: "Üretiliyor",
  draft: "Taslak",
  generationFailed: "Üretilemedi",
  imageNeeded: "Görsel bekliyor",
  ready: "Onay bekliyor",
  approved: "Onaylandı",
  scheduled: "Zamanlandı",
  publishing: "Yayınlanıyor",
  published: "Yayında",
  failed: "Hata",
};

export const STATE_TONE: Record<PostState, TagTone> = {
  generating: "accent",
  draft: "neutral",
  generationFailed: "danger",
  imageNeeded: "accent",
  ready: "warning",
  approved: "success",
  scheduled: "accent",
  publishing: "accent",
  published: "success",
  failed: "danger",
};

// --- filters ----------------------------------------------------------------------------------

export type PostFilter =
  | "all"
  | "draft"
  | "review"
  | "approved"
  | "scheduled"
  | "published"
  | "failed";

export const POST_FILTERS: { id: PostFilter; label: string }[] = [
  { id: "all", label: "Tümü" },
  { id: "draft", label: "Taslak" },
  { id: "review", label: "Onay bekliyor" },
  { id: "approved", label: "Onaylandı" },
  { id: "scheduled", label: "Zamanlandı" },
  { id: "published", label: "Yayınlandı" },
  { id: "failed", label: "Hata" },
];

export function filterMatches(filter: PostFilter, state: PostState): boolean {
  switch (filter) {
    case "all":
      return true;
    case "draft":
      return state === "draft" || state === "generating" || state === "imageNeeded";
    case "review":
      return state === "ready";
    case "approved":
      return state === "approved";
    case "scheduled":
      return state === "scheduled" || state === "publishing";
    case "published":
      return state === "published";
    case "failed":
      return state === "failed" || state === "generationFailed";
  }
}

// --- cards ------------------------------------------------------------------------------------

export interface PostCard {
  id: string;
  content: Content;
  /** The current version, once loaded (null until then or when there is none). */
  version: ContentVersion | null;
  planItem: PlanItem | null;
  /** The active (pending / publishing) schedule, else the latest published or failed one. */
  schedule: Schedule | null;
  /** Latest generation / render job of the post. */
  job: Job | null;
}

export function isActiveJob(job: Job | null | undefined): boolean {
  return !!job && !isTerminalJobStatus(job.status);
}

/** Whether the owner still owes a picture. */
export function needsImage(card: Pick<PostCard, "version" | "planItem">): boolean {
  if (card.version) {
    const slots = slotsIn(card.version.slides);
    if (slots.length > 0) return slots.some((s) => s.state === "empty");
  }
  return card.planItem?.imageSlot === "user_upload" && !card.version;
}

export function cardState(card: PostCard): PostState {
  switch (card.content.status) {
    case "approved":
      return "approved";
    case "scheduled":
      return "scheduled";
    case "publishing":
      return "publishing";
    case "published":
      return "published";
    case "failed":
      return "failed";
    default:
      break;
  }
  if (!card.content.currentVersion) {
    if (isActiveJob(card.job)) return "generating";
    const generation = card.planItem?.generation;
    if (generation && !isTerminalJobStatus(generation.status)) return "generating";
    if (generationFailure(card)) return "generationFailed";
    return card.planItem?.imageSlot === "user_upload" ? "imageNeeded" : "draft";
  }
  return needsImage(card) ? "imageNeeded" : "ready";
}

/** The failed generation that the card should show (A3): its job and the server's reason. */
export interface GenerationFailure {
  jobId: string;
  error: string | null;
}

/**
 * The post's latest generation failed and nothing newer replaced it: no version yet, or the
 * failure came after the current version (a revision that failed). A stopped (cancelled) job is
 * not a failure; a newer job (running or done) settles it.
 */
export function generationFailure(
  card: Pick<PostCard, "content" | "version" | "planItem" | "job">,
): GenerationFailure | null {
  let failed: { id: string; error: string | null; at: string } | null = null;
  if (card.job?.type === "content.generate") {
    if (card.job.status !== "failed") return null;
    failed = {
      id: card.job.id,
      error: card.job.error ?? null,
      at: card.job.finishedAt ?? card.job.updatedAt,
    };
  } else if (card.planItem?.generation?.status === "failed") {
    const g = card.planItem.generation;
    failed = { id: g.jobId, error: g.error, at: card.planItem.updatedAt };
  }
  if (!failed) return null;
  if (card.content.currentVersion) {
    // A version made after the failure (a hand edit, another generation) settles it; without
    // the loaded version the failure is not shown on a post that has a design.
    if (!card.version || Date.parse(card.version.createdAt) >= Date.parse(failed.at)) return null;
  }
  return { jobId: failed.id, error: failed.error };
}

/** Publication moment: the schedule, else the plan's day (local midnight). */
export function cardDay(card: PostCard): Date | null {
  if (card.schedule) return new Date(card.schedule.scheduledAt);
  if (card.planItem?.date) return localDate(card.planItem.date);
  return null;
}

/** Undated cards belong to the month they were created in. */
export function cardMonth(card: PostCard): MonthKey {
  return monthKeyOf(cardDay(card) ?? new Date(card.content.createdAt));
}

export function renderedAssetIds(card: Pick<PostCard, "version">): string[] {
  return (card.version?.slides ?? []).flatMap((s) =>
    s.renderedAssetId ? [s.renderedAssetId] : [],
  );
}

const SCHEDULE_RANK: Partial<Record<string, number>> = {
  pending: 0,
  publishing: 0,
  published: 1,
  failed: 2,
  cancelled: 3,
};
/** A state this version does not know yet ranks with the finished ones. */
const rankOf = (s: Schedule) => SCHEDULE_RANK[s.status] ?? 2;

/** The schedule a card shows: the earliest active one, else the latest published / failed. */
export function pickSchedule(schedules: readonly Schedule[]): Schedule | null {
  let best: Schedule | null = null;
  for (const s of schedules) {
    if (s.status === "cancelled") continue;
    if (!best) {
      best = s;
      continue;
    }
    const a = rankOf(s);
    const b = rankOf(best);
    if (a !== b) {
      if (a < b) best = s;
      continue;
    }
    const earlier = Date.parse(s.scheduledAt) < Date.parse(best.scheduledAt);
    // Active: the earliest; finished: the latest.
    if (a === 0 ? earlier : !earlier) best = s;
  }
  return best;
}

export interface BoardInput {
  contents: readonly Content[];
  /** Loaded versions by content id (only the current one is used). */
  versions?: ReadonlyMap<string, ContentVersion>;
  plans?: readonly Plan[];
  schedules?: readonly Schedule[];
  jobs?: readonly Job[];
}

export function buildBoard(input: BoardInput): PostCard[] {
  const items = new Map<string, PlanItem>();
  // Older plans first, so the newest plan wins for a content id.
  const plans = [...(input.plans ?? [])].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  for (const plan of plans) {
    for (const item of plan.items) if (item.contentId) items.set(item.contentId, item);
  }
  const schedules = new Map<string, Schedule[]>();
  for (const s of input.schedules ?? []) {
    schedules.set(s.contentId, [...(schedules.get(s.contentId) ?? []), s]);
  }
  const jobs = new Map<string, Job>();
  for (const job of input.jobs ?? []) {
    if (job.type !== "content.generate" && job.type !== "content.render") continue;
    if (!job.contentId) continue;
    const existing = jobs.get(job.contentId);
    if (existing && Date.parse(existing.createdAt) >= Date.parse(job.createdAt)) continue;
    jobs.set(job.contentId, job);
  }
  const cards = input.contents.map((content): PostCard => {
    const loaded = input.versions?.get(content.id) ?? null;
    const version =
      loaded &&
      loaded.version === content.currentVersion?.version &&
      loaded.contentId === content.id
        ? loaded
        : null;
    return {
      id: content.id,
      content,
      version,
      planItem: items.get(content.id) ?? null,
      schedule: pickSchedule(schedules.get(content.id) ?? []),
      job: jobs.get(content.id) ?? null,
    };
  });
  return sortCards(cards);
}

/** By day (undated last), then creation time. */
export function sortCards(cards: PostCard[]): PostCard[] {
  return [...cards].sort((a, b) => {
    const x = cardDay(a);
    const y = cardDay(b);
    if (x && y && x.getTime() !== y.getTime()) return x.getTime() - y.getTime();
    if (x && !y) return -1;
    if (!x && y) return 1;
    return Date.parse(a.content.createdAt) - Date.parse(b.content.createdAt);
  });
}

export function cardsInMonth(cards: readonly PostCard[], month: MonthKey): PostCard[] {
  return cards.filter((c) => cardMonth(c) === month);
}

/** Months with cards, ascending. */
export function boardMonths(cards: readonly PostCard[]): MonthKey[] {
  return [...new Set(cards.map(cardMonth))].sort();
}

/** The month to show first: `current` when it has posts, else the nearest one that has. */
export function nearestMonth(months: readonly MonthKey[], current: MonthKey): MonthKey {
  if (months.length === 0 || months.includes(current)) return current;
  const distance = (key: MonthKey) => {
    const [y1, m1] = key.split("-").map(Number);
    const [y2, m2] = current.split("-").map(Number);
    return Math.abs(((y1 ?? 0) - (y2 ?? 0)) * 12 + ((m1 ?? 0) - (m2 ?? 0)));
  };
  return [...months].sort((a, b) => distance(a) - distance(b) || (a < b ? 1 : -1))[0] ?? current;
}

/** The nearest month in `direction` (−1 / +1) that has posts (null: none). */
export function monthWithPosts(
  months: readonly MonthKey[],
  current: MonthKey,
  direction: -1 | 1,
): MonthKey | null {
  const candidates = months.filter((m) => (direction < 0 ? m < current : m > current));
  return (direction < 0 ? candidates.at(-1) : candidates[0]) ?? null;
}

export { addMonths };

export function filterCounts(cards: readonly PostCard[]): Record<PostFilter, number> {
  const counts = {} as Record<PostFilter, number>;
  for (const f of POST_FILTERS) counts[f.id] = 0;
  for (const card of cards) {
    const state = cardState(card);
    for (const f of POST_FILTERS) if (filterMatches(f.id, state)) counts[f.id] += 1;
  }
  return counts;
}

/** Turkish-insensitive match ("İ" / "i", "ş" / "s" …). */
export function fold(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function matchesSearch(card: PostCard, query: string, brandName?: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const haystack = [card.content.title, card.content.caption, card.content.brief, brandName ?? ""]
    .map(fold)
    .join("\n");
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export interface BoardView {
  month: MonthKey;
  filter: PostFilter;
  query: string;
  brandName?: (brandId: string) => string | undefined;
}

/** The month's cards that pass the search, and the filter counts over them. */
export function visibleCards(
  cards: readonly PostCard[],
  view: BoardView,
): { cards: PostCard[]; counts: Record<PostFilter, number>; monthTotal: number } {
  const month = cardsInMonth(cards, view.month);
  const searched = month.filter((c) =>
    matchesSearch(c, view.query, view.brandName?.(c.content.brandId)),
  );
  return {
    cards: searched.filter((c) => filterMatches(view.filter, cardState(c))),
    counts: filterCounts(searched),
    monthTotal: month.length,
  };
}

/** Cards grouped by brand, in the brands' order (unknown brands last). */
export function groupByBrand<T extends { content: Pick<Content, "brandId"> }>(
  cards: readonly T[],
  brandOrder: readonly string[],
): { brandId: string; cards: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const c of cards)
    groups.set(c.content.brandId, [...(groups.get(c.content.brandId) ?? []), c]);
  const rank = (id: string) => {
    const i = brandOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([brandId, list]) => ({ brandId, cards: list }));
}

/**
 * Arrow-key selection in the visible order: `offset` cards (±1, ±columns for rows).
 * Nothing selected: the first card (or the last going back).
 */
export function moveSelection(
  ids: readonly string[],
  selected: string | null,
  offset: number,
): string | null {
  if (ids.length === 0) return null;
  const index = selected ? ids.indexOf(selected) : -1;
  if (index < 0) return (offset < 0 ? ids.at(-1) : ids[0]) ?? null;
  return ids[Math.max(0, Math.min(ids.length - 1, index + offset))] ?? null;
}

// --- multi-select (N1) ----------------------------------------------------------------------------

/** ⌘-click: add or take out one card. */
export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/**
 * ⇧-click: every card between the anchor and `id` in the visible order, added to the selection
 * (no anchor, or one that is not visible: just `id`).
 */
export function rangeSelection(
  ordered: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  id: string,
): string[] {
  const from = anchor ? ordered.indexOf(anchor) : -1;
  const to = ordered.indexOf(id);
  if (to < 0) return [...selected];
  if (from < 0) return selected.includes(id) ? [...selected] : [...selected, id];
  const [a, b] = from <= to ? [from, to] : [to, from];
  const range = ordered.slice(a, b + 1);
  return [...selected.filter((s) => !range.includes(s)), ...range];
}

/** The selection limited to what is still visible, in the visible order. */
export function visibleSelection(
  ordered: readonly string[],
  selected: readonly string[],
): string[] {
  return ordered.filter((id) => selected.includes(id));
}

/** Why a post cannot be deleted (null: it can). */
export function deletionBlocker(content: Pick<Content, "status">): string | null {
  switch (content.status) {
    case "scheduled":
      return "Zamanlanmış post silinemez; önce zamanlamayı iptal et (postun … menüsünde ya da Takvim'de).";
    case "publishing":
      return "Yayınlanmakta olan post silinemez.";
    case "published":
      return "Yayınlanmış post silinemez.";
    default:
      return null;
  }
}

// --- text -------------------------------------------------------------------------------------

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/** "Instagram", "Reels", "Instagram + 1" for the card's meta line. */
export function platformText(content: Pick<Content, "type" | "targetPlatforms">): string {
  if (content.type === "reel") return "Reels";
  if (content.type === "story") return "Hikâye";
  const [first, ...rest] = content.targetPlatforms;
  if (!first) return content.type === "carousel" ? "Kaydırmalı" : "Post";
  return rest.length > 0 ? `${PLATFORM_LABEL[first]} +${rest.length}` : PLATFORM_LABEL[first];
}

/** "Instagram · 18 Kas 10:00", "LinkedIn · 28 Kas" (plan day), "Post · 17 Kas" (created). */
export function cardMetaText(card: PostCard): string {
  const platform = platformText(card.content);
  if (card.schedule) return `${platform} · ${shortDayTime(new Date(card.schedule.scheduledAt))}`;
  const day = cardDay(card);
  return `${platform} · ${shortDay(day ?? new Date(card.content.createdAt))}`;
}

/** Human names of the content types ("Tek görsel", "Kaydırmalı", "Hikâye", "Reels"). */
export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  post: "Tek görsel",
  carousel: "Kaydırmalı",
  story: "Hikâye",
  reel: "Reels",
};

/** "Kaydırmalı · 5 kare · 4:5" */
export function formatText(
  type: ContentType,
  slides: readonly { width: number; height: number }[],
): string {
  const first = slides[0];
  const parts = [CONTENT_TYPE_LABEL[type]];
  if (type === "carousel" || slides.length > 1) parts.push(`${slides.length} kare`);
  if (first) parts.push(aspectLabel(first.width, first.height));
  return parts.join(" · ");
}

// --- approval hash ------------------------------------------------------------------------------

const hashCache = new Map<string, Promise<string>>();

/** SHA-256 of a version's slides, recomputed here (cached per version id). */
export function versionHash(version: ContentVersion): Promise<string> {
  const key = `${version.id}:${version.contentHash}`;
  let hash = hashCache.get(key);
  if (!hash) {
    hash = computeContentHash(version.slides);
    hashCache.set(key, hash);
    if (hashCache.size > 400) hashCache.delete(hashCache.keys().next().value as string);
  }
  return hash;
}

/**
 * The hash to approve with: the loaded version is the current one and its recomputed hash
 * equals what the server reports (null otherwise, or when the status cannot be approved).
 */
export async function approvableHash(
  content: Content,
  version: ContentVersion | null,
): Promise<string | null> {
  if (!statusIn(content.status, APPROVABLE_STATUSES)) return null;
  const ref = content.currentVersion;
  if (!ref || !version || version.version !== ref.version || version.contentId !== content.id)
    return null;
  const local = await versionHash(version);
  return local === ref.contentHash ? local : null;
}
