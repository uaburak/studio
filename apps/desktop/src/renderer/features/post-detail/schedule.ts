// The schedule sheet's rules (pure, tested without views) and its submit: local date and time,
// accounts of the post's brand on its platforms, platform rules (preflight), approve first
// when needed (with the verified hash), one schedule per account (an account the post already
// waits on moves to the new time), publish now. Port of the Mac's ScheduleSheetModel and
// StudioKit's PublishingDomain.
import {
  type ApiClient,
  type Content,
  type PreflightIssue,
  type PublishingMode,
  reelDurationIssues,
  SCHEDULABLE_STATUSES,
  type Schedule,
  type SchedulePreflight,
  type SocialAccount,
  statusIn,
} from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";
import { PLATFORM_LABEL } from "../posts/board.ts";
import { localDate } from "../posts/dates.ts";

/** The API refuses times in the past; the earliest it accepts with a margin. */
export function earliestSchedule(now: Date = new Date()): Date {
  return new Date(now.getTime() + 60_000);
}

/** 10:00 on `day`, or the next half hour when that has passed. */
export function defaultTime(day: Date, now: Date = new Date()): Date {
  const ten = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0, 0);
  if (ten > earliestSchedule(now)) return ten;
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() < 30 ? 30 : 60);
  return next;
}

/** The pending schedule's time, else the plan day at 10:00, else tomorrow 10:00. */
export function defaultScheduleDate(
  card: { schedule: Schedule | null; planItem: { date: string | null } | null },
  now: Date = new Date(),
): Date {
  const s = card.schedule;
  if (s && (s.status === "pending" || s.status === "failed")) {
    const at = new Date(s.scheduledAt);
    if (at > earliestSchedule(now)) return at;
  }
  const planDay = card.planItem?.date ? localDate(card.planItem.date) : null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // A plan day that has passed is no default.
  if (planDay && planDay >= today) return defaultTime(planDay, now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return defaultTime(tomorrow, now);
}

export function dateError(date: Date | null, now: Date = new Date()): string | null {
  if (!date || Number.isNaN(date.getTime())) return "Geçerli bir tarih ve saat seç.";
  if (date < earliestSchedule(now)) return "Yayın zamanı en az bir dakika sonrası olmalı.";
  return null;
}

/** Accounts the post can go to: its brand's, not disabled, on one of its platforms. */
export function schedulableAccounts(
  accounts: readonly SocialAccount[],
  content: Pick<Content, "brandId" | "targetPlatforms">,
): SocialAccount[] {
  return accounts.filter(
    (a) =>
      a.brandId === content.brandId &&
      a.status !== "disabled" &&
      content.targetPlatforms.includes(a.platform),
  );
}

/** Preselected: the connected ones. */
export function defaultAccountIds(accounts: readonly SocialAccount[]): string[] {
  return accounts.filter((a) => a.status === "connected").map((a) => a.id);
}

export function needsApproval(content: Pick<Content, "status">): boolean {
  return !statusIn(content.status, SCHEDULABLE_STATUSES);
}

export function preflightIssues(
  preflight: SchedulePreflight | null,
  accountId: string,
): { errors: PreflightIssue[]; warnings: PreflightIssue[] } {
  const target = preflight?.targets.find((t) => t.socialAccountId === accountId);
  return { errors: target?.errors ?? [], warnings: target?.warnings ?? [] };
}

export interface SheetState {
  content: Content | null;
  accounts: readonly SocialAccount[];
  selected: readonly string[];
  preflight: SchedulePreflight | null;
  /** Reel length, when the post is a reel (platform limits). */
  reelDurationMs?: number | null;
  /** The version is verified for approval (needed when the post is not approved yet). */
  approvable?: boolean;
}

/** Why the post cannot go out now (null: it can). */
export function blockingReason(s: SheetState): string | null {
  if (!s.content) return "Zamanlanacak onaylı bir post seçin.";
  if (s.content.status === "publishing" || s.content.status === "published")
    return "Bu post yayınlandı ya da yayınlanıyor.";
  if (!s.content.currentVersion) return "Postun henüz bir tasarım sürümü yok.";
  if (s.selected.length === 0) {
    return s.accounts.length === 0
      ? "Bu markada bu postun platformlarında bağlı hesap yok. Ayarlar → Hesaplar'dan bağlayın."
      : "En az bir hesap seçin.";
  }
  if (needsApproval(s.content) && s.approvable === false)
    return "Bu sürüm doğrulanamadı; onaylamak için postu yenile.";
  if (s.content.type === "reel" && s.reelDurationMs != null) {
    const platforms = s.accounts.filter((a) => s.selected.includes(a.id)).map((a) => a.platform);
    const issue = reelDurationIssues(s.reelDurationMs, platforms)[0];
    if (issue) return issue.message;
  }
  if (s.preflight) {
    const first = s.preflight.errors[0];
    if (first) return first.message;
    const bad = s.preflight.targets.find((t) => s.selected.includes(t.socialAccountId) && !t.ok);
    const error = bad?.errors[0];
    if (bad && error) return `${bad.handle}: ${error.message}`;
  }
  return null;
}

export function modeSummary(mode: PublishingMode): string {
  return mode === "cloud"
    ? "Bulut yayıncı açık: onaylanan zamanlamalar buluta gönderilir, Mac kapalıyken de paylaşılır."
    : "Yayını bu Mac yapar: zamanlanan saatte Mac açık ve Studio çalışıyor olmalı.";
}

export function accountLabel(a: Pick<SocialAccount, "platform" | "handle">): string {
  return `${PLATFORM_LABEL[a.platform]} · ${a.handle}`;
}

export function publishNowConfirmation(title: string, accounts: readonly SocialAccount[]): string {
  return `“${title}” şu hesaplarda hemen paylaşılacak: ${accounts.map(accountLabel).join(", ")}. Paylaşılan gönderi Studio'dan geri alınamaz.`;
}

// --- schedule state in words ------------------------------------------------------------------

export interface ScheduleDisplay {
  label: string;
  detail: string | null;
  tone: TagTone;
}

export function scheduleDisplay(schedule: Schedule, mode: PublishingMode): ScheduleDisplay {
  switch (schedule.status) {
    case "pending":
      if (schedule.delivery === "cloud" && schedule.cloudSyncedAt)
        return {
          label: "Bulutta",
          detail: "Mac kapalı olsa da zamanında paylaşılır.",
          tone: "accent",
        };
      if (mode === "cloud" || schedule.delivery === "cloud") {
        return schedule.lastError
          ? { label: "Buluta gönderilemedi", detail: schedule.lastError, tone: "danger" }
          : {
              label: "Buluta gönderiliyor",
              detail: "Bulut yayıncıya aktarılıyor.",
              tone: "accent",
            };
      }
      return {
        label: "Zamanlandı",
        detail: "Mac açık olmalı: yayını bu Mac yapacak.",
        tone: "accent",
      };
    case "publishing":
      return { label: "Yayınlanıyor", detail: "Platforma gönderiliyor.", tone: "accent" };
    case "published":
      return { label: "Yayınlandı", detail: null, tone: "success" };
    case "failed":
      return {
        label: "Hata",
        detail: schedule.lastError ?? "Yayın başarısız oldu.",
        tone: "danger",
      };
    case "cancelled":
      return { label: "İptal edildi", detail: null, tone: "neutral" };
  }
}

// --- submit -----------------------------------------------------------------------------------

export type ScheduleApi = {
  contents: Pick<ApiClient["contents"], "get" | "approve">;
  schedules: Pick<ApiClient["schedules"], "list" | "create" | "update" | "publishNow">;
};

export class SubmitError extends Error {
  constructor(
    message: string,
    /** Schedules that went through before the failure. */
    readonly created: Schedule[],
  ) {
    super(message);
  }
}

async function approveIfNeeded(
  api: ScheduleApi,
  content: Content,
  hash: string | null,
): Promise<Content> {
  if (!needsApproval(content)) return content;
  if (!hash) throw new SubmitError("Zamanlamak için önce bu sürümün onaylanması gerekiyor.", []);
  return api.contents.approve(content.id, hash);
}

/**
 * Approve when needed, then one schedule per account at `date` (UTC on the wire). An account
 * the post already waits on moves to the new time instead of getting a second schedule.
 */
export async function submitSchedule(
  api: ScheduleApi,
  input: { content: Content; hash: string | null; accountIds: readonly string[]; date: Date },
): Promise<{ schedules: Schedule[]; content: Content }> {
  await approveIfNeeded(api, input.content, input.hash);
  const created: Schedule[] = [];
  try {
    const waiting = (
      await api.schedules.list({ contentId: input.content.id, status: "pending", limit: 100 })
    ).items;
    const scheduledAt = input.date.toISOString();
    for (const accountId of [...input.accountIds].sort()) {
      const pending = waiting.find((s) => s.socialAccountId === accountId);
      created.push(
        pending
          ? await api.schedules.update(pending.id, { scheduledAt })
          : await api.schedules.create({
              contentId: input.content.id,
              socialAccountId: accountId,
              scheduledAt,
            }),
      );
    }
  } catch (e) {
    throw new SubmitError(e instanceof Error ? e.message : String(e), created);
  }
  const content = await api.contents.get(input.content.id);
  return { schedules: created, content };
}

/** "Şimdi yayınla" (after the owner confirmed). */
export async function submitPublishNow(
  api: ScheduleApi,
  input: { content: Content; hash: string | null; accountIds: readonly string[] },
): Promise<{ schedules: Schedule[]; content: Content }> {
  await approveIfNeeded(api, input.content, input.hash);
  const result = await api.schedules.publishNow({
    contentId: input.content.id,
    socialAccountIds: [...input.accountIds].sort(),
  });
  const content = await api.contents.get(input.content.id);
  return { schedules: result.schedules, content };
}
