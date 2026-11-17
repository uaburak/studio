import type { Content, Plan, PlanItem, Schedule, SocialAccount } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addMonths,
  buildEntries,
  checkMove,
  dayKey,
  daySummaries,
  dayTitle,
  defaultDay,
  entriesOn,
  monthGrid,
  monthTitle,
  moveTarget,
  nearestActiveMonth,
  needsAttention,
  scheduleLabel,
  scheduleState,
  weekDays,
  weekRowHour,
  withMovedSchedule,
} from "../../src/renderer/features/calendar/calendar-model.ts";
import { T } from "./fixtures.ts";

// Tests run in Europe/Istanbul (UTC+3, no DST).
const at = (local: string) => new Date(local).toISOString();

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    contentId: "p1",
    brandId: "b1",
    platform: "instagram",
    socialAccountId: "acc1",
    versionId: "v1",
    contentHash: "a".repeat(64),
    scheduledAt: at("2026-11-18T10:00:00"),
    status: "pending",
    permalink: null,
    delivery: null,
    cloudSyncedAt: null,
    lastError: null,
    cancelledAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function content(over: Partial<Content> = {}): Content {
  return {
    id: "p1",
    brandId: "b1",
    type: "carousel",
    title: "Hasat sonrası toprak bakımı",
    brief: "",
    status: "scheduled",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function planItem(over: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "i1",
    planId: "pl1",
    position: 0,
    date: "2026-11-22",
    platforms: ["instagram"],
    contentType: "reel",
    title: "Damla sulama",
    brief: "",
    pillar: null,
    imageSlot: "none",
    imageBrief: null,
    status: "accepted",
    contentId: "p3",
    generation: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function plan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  return {
    id: "pl1",
    brandId: "b1",
    conversationId: null,
    runId: null,
    title: "Kasım",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    status: "accepted",
    summary: "",
    revision: 1,
    decidedAt: T,
    rejectionReason: null,
    items,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

const account: SocialAccount = {
  id: "acc1",
  brandId: "b1",
  platform: "instagram",
  handle: "mtmagro",
  status: "connected",
} as SocialAccount;

describe("calendar grid", () => {
  it("covers whole weeks, Monday first, with the neighbouring months' days", () => {
    // November 2026 starts on a Sunday: six leading days of October, six rows.
    const cells = monthGrid({ year: 2026, month: 11 });
    expect(cells).toHaveLength(42);
    expect(cells[0]).toEqual({ day: "2026-10-26", inMonth: false });
    expect(cells[6]).toEqual({ day: "2026-11-01", inMonth: true });
    expect(cells[35]).toEqual({ day: "2026-11-30", inMonth: true });
    expect(cells.at(-1)).toEqual({ day: "2026-12-06", inMonth: false });
    // February 2027 starts on a Monday and fills exactly four weeks.
    const feb = monthGrid({ year: 2027, month: 2 });
    expect(feb).toHaveLength(28);
    expect(feb.every((c) => c.inMonth)).toBe(true);
  });

  it("titles months and days in Turkish", () => {
    expect(monthTitle({ year: 2026, month: 11 })).toBe("Kasım 2026");
    expect(dayTitle("2026-11-18")).toBe("18 Kasım Çarşamba");
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(weekDays("2026-11-18")).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("calendar entries", () => {
  const contents = [
    content(),
    content({ id: "p2", title: "Partner Agro bayi ağı", type: "post", status: "in_review" }),
    content({ id: "p3", title: "Damla sulama · 30 sn", type: "reel", status: "draft" }),
  ];

  it("builds schedule rows and dated posts, skipping posts that have a schedule", () => {
    const entries = buildEntries({
      schedules: [schedule(), schedule({ id: "s0", status: "cancelled" })],
      contents,
      plans: [
        plan([
          planItem({ id: "a", contentId: "p1", date: "2026-11-25" }),
          planItem({ id: "b", contentId: "p2", date: "2026-11-18", contentType: "post" }),
          planItem({ id: "c", contentId: "p3" }),
          planItem({ id: "d", contentId: null, status: "planned" }),
        ]),
      ],
      accounts: [account],
      brandName: "MTM Agro",
    });
    expect(entries.map((e) => [e.id, e.day, e.time, e.status])).toEqual([
      ["sch-s1", "2026-11-18", "10:00", "Zamanlandı"],
      ["post-p2", "2026-11-18", "—", "Onay bekliyor"],
      ["post-p3", "2026-11-22", "—", "Taslak"],
    ]);
    const [first, second, third] = entries;
    expect(first).toMatchObject({
      title: "Hasat sonrası toprak bakımı",
      meta: "MTM Agro · kaydırmalı",
      handle: "@mtmagro",
      tone: "accent",
      kind: "scheduled",
      canMove: true,
      needsOwner: false,
      platform: "instagram",
    });
    expect(second).toMatchObject({ tone: "warning", kind: "planned", canMove: false });
    expect(third).toMatchObject({ meta: "MTM Agro · Reels", contentType: "reel" });
  });

  it("maps every schedule state like StudioKit's ScheduleDisplayState", () => {
    const label = (s: Partial<Schedule>, mode: "local" | "cloud" = "local") =>
      scheduleLabel(scheduleState(schedule(s), mode));
    expect(label({})).toBe("Zamanlandı");
    expect(label({}, "cloud")).toBe("Buluta gönderiliyor");
    expect(label({ delivery: "cloud", lastError: "Reddedildi" })).toBe("Buluta gönderilemedi");
    expect(label({ delivery: "cloud", cloudSyncedAt: T })).toBe("Bulutta");
    expect(label({ status: "publishing" })).toBe("Yayınlanıyor");
    expect(label({ status: "published" })).toBe("Yayınlandı");
    expect(label({ status: "failed" })).toBe("Hata");
    expect(scheduleState(schedule({ status: "failed" }), "local")).toEqual({
      kind: "failed",
      reason: "Yayın başarısız oldu.",
    });
  });

  it("puts problems first in the day's dots and lists what needs the owner", () => {
    const entries = buildEntries({
      schedules: [
        schedule({ id: "ok", status: "published" }),
        schedule({ id: "bad", contentId: "p2", status: "failed", lastError: "Token geçersiz" }),
        schedule({ id: "later", contentId: "p3", scheduledAt: at("2026-11-18T18:00:00") }),
      ],
      contents,
      plans: [],
    });
    const summary = daySummaries(entries).get("2026-11-18");
    expect(summary).toEqual({ dots: ["error", "scheduled", "published"], count: 3 });
    expect(needsAttention(entries).map((e) => e.scheduleId)).toEqual(["bad"]);
    expect(entriesOn(entries, "2026-11-18").map((e) => e.time)).toEqual([
      "10:00",
      "10:00",
      "18:00",
    ]);
    const failed = entries.find((e) => e.scheduleId === "bad");
    expect(failed).toMatchObject({ tone: "danger", detail: "Token geçersiz", canMove: false });
  });

  it("picks the day and month to show", () => {
    const entries = buildEntries({
      schedules: [schedule({ scheduledAt: at("2027-01-12T09:00:00") })],
      contents,
      plans: [],
    });
    expect(defaultDay({ year: 2026, month: 11 }, entries, "2026-11-17")).toBe("2026-11-17");
    expect(defaultDay({ year: 2027, month: 1 }, entries, "2026-11-17")).toBe("2027-01-12");
    expect(defaultDay({ year: 2027, month: 2 }, entries, "2026-11-17")).toBe("2027-02-01");
    expect(nearestActiveMonth(entries, { year: 2026, month: 11 })).toEqual({
      year: 2027,
      month: 1,
    });
    expect(nearestActiveMonth([], { year: 2026, month: 11 })).toEqual({ year: 2026, month: 11 });
  });
});

describe("drag to reschedule", () => {
  const now = new Date("2026-11-17T12:00:00").getTime();
  const pending = buildEntries({ schedules: [schedule()], contents: [content()], plans: [] })[0];

  it("keeps the local time on the new day, or takes the week view's hour", () => {
    const original = new Date("2026-11-18T10:30:00").getTime();
    expect(new Date(moveTarget(original, "2026-11-20")).toString()).toBe(
      new Date("2026-11-20T10:30:00").toString(),
    );
    expect(new Date(moveTarget(original, "2026-11-20", 15)).toString()).toBe(
      new Date("2026-11-20T15:30:00").toString(),
    );
    expect(weekRowHour(new Date("2026-11-18T03:00:00").getTime())).toBe(6);
    expect(weekRowHour(new Date("2026-11-18T23:40:00").getTime())).toBe(23);
  });

  it("moves pending schedules only, not into the past, and ignores a drop on the same day", () => {
    if (!pending) throw new Error("no entry");
    const moved = checkMove(pending, "2026-11-25", now);
    expect(moved.kind).toBe("move");
    if (moved.kind === "move") {
      expect(new Date(moved.target).toISOString()).toBe(at("2026-11-25T10:00:00"));
    }
    expect(checkMove(pending, "2026-11-18", now)).toEqual({ kind: "same" });
    expect(checkMove(pending, "2026-11-10", now)).toEqual({
      kind: "refused",
      reason: "Geçmiş bir zamana taşınamaz.",
    });
    // Today at 10:00 has already passed at noon.
    expect(checkMove(pending, "2026-11-17", now).kind).toBe("refused");
    expect(checkMove({ ...pending, canMove: false }, "2026-11-25", now)).toEqual({
      kind: "refused",
      reason: "Yalnızca bekleyen zamanlamalar taşınabilir.",
    });
  });

  it("updates the cached list optimistically", () => {
    const target = new Date("2026-11-25T10:00:00").getTime();
    const list = withMovedSchedule([schedule(), schedule({ id: "s2" })], "s1", target);
    expect(list[0]?.scheduledAt).toBe(at("2026-11-25T10:00:00"));
    expect(list[1]?.scheduledAt).toBe(at("2026-11-18T10:00:00"));
  });
});
