// Bulk work on the picked cards (N1, N3) as plain values (tested without views): which posts
// each action takes and why the others are left out, and the times "Zamanla" gives them — one
// per post spread over the chosen days, or each post's own planned day.
import {
  APPROVABLE_STATUSES,
  SCHEDULABLE_STATUSES,
  type SocialAccount,
  statusIn,
} from "@studio/contract";
import { schedulableAccounts } from "../post-detail/schedule.ts";
import { cardDay, deletionBlocker, isActiveJob, type PostCard } from "./board.ts";
import { localDate } from "./dates.ts";

/** A post an action leaves out, with the reason in Turkish. */
export interface Excluded {
  card: PostCard;
  reason: string;
}

export interface Split {
  take: PostCard[];
  skip: Excluded[];
}

function split(cards: readonly PostCard[], why: (card: PostCard) => string | null): Split {
  const take: PostCard[] = [];
  const skip: Excluded[] = [];
  for (const card of cards) {
    const reason = why(card);
    if (reason) skip.push({ card, reason });
    else take.push(card);
  }
  return { take, skip };
}

/** "Onayla": posts with a design that wait for approval. */
export function approvable(cards: readonly PostCard[]): Split {
  return split(cards, (card) => {
    const c = card.content;
    if (c.status === "approved" || c.status === "scheduled") return "Zaten onaylı.";
    if (!statusIn(c.status, APPROVABLE_STATUSES)) return "Bu durumda onaylanamaz.";
    if (!c.currentVersion) return "Henüz tasarımı yok.";
    if (isActiveJob(card.job)) return "Üretimi ya da render'ı sürüyor.";
    return null;
  });
}

/** "Zamanla": approved posts (a post that is not approved yet is approved first, one by one). */
export function schedulable(cards: readonly PostCard[]): Split {
  return split(cards, (card) => {
    const c = card.content;
    if (c.status === "publishing" || c.status === "published")
      return "Yayınlandı ya da yayınlanıyor.";
    if (!statusIn(c.status, SCHEDULABLE_STATUSES)) return "Önce onaylanmalı.";
    if (!c.currentVersion) return "Henüz tasarımı yok.";
    return null;
  });
}

/** "Sil": everything except scheduled / publishing / published posts. */
export function deletable(cards: readonly PostCard[]): Split {
  return split(cards, (card) => deletionBlocker(card.content));
}

/** "Talimat uygula": posts with a design that are not being worked on or published. */
export function revisable(cards: readonly PostCard[]): Split {
  return split(cards, (card) => {
    const c = card.content;
    if (!c.currentVersion) return "Henüz tasarımı yok; önce üretilmeli.";
    if (c.status === "publishing" || c.status === "published")
      return "Yayınlandı ya da yayınlanıyor.";
    if (isActiveJob(card.job)) return "Üretimi ya da render'ı sürüyor.";
    return null;
  });
}

/** Approved or scheduled posts lose their approval when a new version arrives. */
export function approvalLosses(cards: readonly PostCard[]): PostCard[] {
  return cards.filter((c) => c.content.status === "approved" || c.content.status === "scheduled");
}

// --- times for "Zamanla" -----------------------------------------------------------------------

export type SpreadMode = "planned" | "spread";

export interface SpreadInput {
  mode: SpreadMode;
  /** First and last day (local `yyyy-mm-dd`), for `spread`. */
  from: string;
  to: string;
  /** Local `hh:mm` every post goes out at (posts sharing a day are 30 min apart). */
  time: string;
}

export interface Timing {
  card: PostCard;
  /** The moment, or null with the reason it has none. */
  at: Date | null;
  reason: string | null;
}

/** Days `from`..`to` inclusive (local midnights; empty when they do not parse or are reversed). */
export function daysBetween(from: string, to: string): Date[] {
  const a = localDate(from);
  const b = localDate(to);
  if (!a || !b || b < a) return [];
  const out: Date[] = [];
  for (let d = new Date(a); d <= b && out.length < 366; d.setDate(d.getDate() + 1))
    out.push(new Date(d));
  return out;
}

function at(day: Date, time: string, extraMinutes: number): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const out = new Date(day);
  out.setHours(Number(m[1]), Number(m[2]) + extraMinutes, 0, 0);
  return out;
}

/**
 * One time per post: `planned` keeps each post's day (its schedule, else its plan day) at
 * `time`; `spread` deals the posts (in board order) evenly over the days, one a day while there
 * are enough days; posts sharing a day go out 30 minutes apart.
 */
export function spreadTimes(cards: readonly PostCard[], input: SpreadInput): Timing[] {
  if (input.mode === "planned") {
    const perDay = new Map<string, number>();
    return cards.map((card) => {
      const day = cardDay(card);
      if (!day) return { card, at: null, reason: "Plan tarihi yok." };
      const key = day.toDateString();
      const n = perDay.get(key) ?? 0;
      perDay.set(key, n + 1);
      const when = at(day, input.time, n * 30);
      return when ? { card, at: when, reason: null } : { card, at: null, reason: "Saat geçersiz." };
    });
  }
  const days = daysBetween(input.from, input.to);
  if (days.length === 0)
    return cards.map((card) => ({ card, at: null, reason: "Gün aralığı geçersiz." }));
  const perDay = new Map<number, number>();
  return cards.map((card, i) => {
    const index = Math.floor((i * days.length) / cards.length);
    const n = perDay.get(index) ?? 0;
    perDay.set(index, n + 1);
    const when = at(days[index] as Date, input.time, n * 30);
    return when ? { card, at: when, reason: null } : { card, at: null, reason: "Saat geçersiz." };
  });
}

/** Accounts a post goes to in a bulk schedule: the connected ones of its brand and platforms. */
export function bulkAccounts(card: PostCard, accounts: readonly SocialAccount[]): SocialAccount[] {
  return schedulableAccounts(accounts, card.content).filter((a) => a.status === "connected");
}

/** "3 post" / "1 post" */
export function postCount(n: number): string {
  return `${n} post`;
}

/** `run` over `items`, at most `limit` at a time, results in order (a failure is a result). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        out[index] = { status: "fulfilled", value: await run(items[index] as T, index) };
      } catch (reason) {
        out[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
