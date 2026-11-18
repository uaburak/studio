// The month plans view (N2) as plain values (tested without views): where each plan item stands
// (bekliyor / üretiliyor / üretildi / başarısız / onaylandı / zamanlandı …), what it offers
// (Üret, Yeniden dene, Yeniden üret), the plan's counts and its buttons, and the edit form.
import {
  type Content,
  type ContentType,
  isTerminalJobStatus,
  type Plan,
  type PlanGenerateSkipReason,
  type PlanItem,
  type PlanItemPatch,
  type Platform,
} from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";
import { CONTENT_TYPE_LABEL } from "./board.ts";
import { localDate, monthTitle } from "./dates.ts";
import { failureText } from "./failure.ts";

export type ItemState =
  /** In a plan that is not accepted yet. */
  | "planned"
  /** Left out when the plan was accepted. */
  | "skipped"
  /** Accepted, no design yet, nothing running. */
  | "pending"
  | "generating"
  | "generated"
  /** The last generation failed (or was stopped) and there is no design. */
  | "failed"
  | "approved"
  | "scheduled"
  | "published"
  /** Its post was deleted. */
  | "deleted";

export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  planned: "Planlandı",
  skipped: "Atlandı",
  pending: "Bekliyor",
  generating: "Üretiliyor",
  generated: "Üretildi",
  failed: "Başarısız",
  approved: "Onaylandı",
  scheduled: "Zamanlandı",
  published: "Yayında",
  deleted: "Silindi",
};

export const ITEM_STATE_TONE: Record<ItemState, TagTone> = {
  planned: "neutral",
  skipped: "neutral",
  pending: "neutral",
  generating: "accent",
  generated: "warning",
  failed: "danger",
  approved: "success",
  scheduled: "accent",
  published: "success",
  deleted: "neutral",
};

/**
 * Where an item stands. `content`: its post from the board's list — undefined while that list is
 * not loaded, null when the post is not in it (deleted).
 */
export function itemState(item: PlanItem, content: Content | null | undefined): ItemState {
  if (item.status === "planned") return "planned";
  if (item.status === "skipped") return "skipped";
  if (!item.contentId || content === null) return "deleted";
  const gen = item.generation;
  if (gen && !isTerminalJobStatus(gen.status)) return "generating";
  switch (content?.status) {
    case "approved":
      return "approved";
    case "scheduled":
    case "publishing":
      return "scheduled";
    case "published":
      return "published";
    default:
      break;
  }
  if (content?.currentVersion) return "generated";
  if (gen && (gen.status === "failed" || gen.status === "cancelled")) return "failed";
  if (!content && gen?.status === "succeeded") return "generated";
  return "pending";
}

/** The item's failure in Turkish (null unless it failed). */
export function itemFailure(item: PlanItem, state: ItemState): string | null {
  if (state !== "failed") return null;
  if (item.generation?.status === "cancelled") return "Üretim durduruldu.";
  return failureText(item.generation?.error).text;
}

export type ItemAction =
  /** First generation. */
  | "generate"
  /** After a failure. */
  | "retry"
  /** Replace the design (asks first; edited / approved posts need a second yes). */
  | "regenerate"
  | null;

export function itemAction(state: ItemState): ItemAction {
  switch (state) {
    case "pending":
      return "generate";
    case "failed":
      return "retry";
    case "generated":
    case "approved":
      return "regenerate";
    default:
      return null;
  }
}

export const ITEM_ACTION_LABEL: Record<Exclude<ItemAction, null>, string> = {
  generate: "Üret",
  retry: "Yeniden dene",
  regenerate: "Yeniden üret",
};

export interface PlanCounts {
  total: number;
  pending: number;
  generating: number;
  failed: number;
  done: number;
}

export function planCounts(
  plan: Plan,
  contentOf: (id: string | null) => Content | null | undefined,
): PlanCounts {
  const out: PlanCounts = { total: 0, pending: 0, generating: 0, failed: 0, done: 0 };
  for (const item of plan.items) {
    const state = itemState(item, contentOf(item.contentId));
    if (state === "skipped") continue;
    out.total += 1;
    if (state === "pending") out.pending += 1;
    else if (state === "generating") out.generating += 1;
    else if (state === "failed") out.failed += 1;
    else if (state !== "planned" && state !== "deleted") out.done += 1;
  }
  return out;
}

/** Items whose last generation failed ("Yalnızca başarısızları üret"). */
export function failedItemIds(
  plan: Plan,
  contentOf: (id: string | null) => Content | null | undefined,
): string[] {
  return plan.items
    .filter((i) => itemState(i, contentOf(i.contentId)) === "failed")
    .map((i) => i.id);
}

/** AI picture slots among items (for the estimate). */
export function imageSlotsOf(items: readonly PlanItem[]): number {
  return items.filter((i) => i.imageSlot === "ai_generate").length;
}

export const PLAN_STATUS_LABEL: Record<Plan["status"], string> = {
  draft: "Taslak",
  proposed: "Onay bekliyor",
  accepted: "Onaylandı",
  rejected: "Reddedildi",
  superseded: "Yenisi var",
};

export const PLAN_STATUS_TONE: Record<Plan["status"], TagTone> = {
  draft: "neutral",
  proposed: "accent",
  accepted: "success",
  rejected: "danger",
  superseded: "neutral",
};

/** Plans the list shows (a superseded draft is noise), newest period first, grouped by month. */
export function planGroups(
  plans: readonly Plan[],
): { month: string; title: string; plans: Plan[] }[] {
  const shown = plans.filter((p) => p.status !== "superseded");
  const groups = new Map<string, Plan[]>();
  for (const plan of shown) {
    const month = plan.periodStart.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), plan]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, list]) => ({
      month,
      title: monthTitle(month),
      plans: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }));
}

/** "Hasat kampanyası" or "Kasım planı". */
export function planTitle(plan: Pick<Plan, "title" | "periodStart">): string {
  return plan.title.trim() || `${monthTitle(plan.periodStart.slice(0, 7))} planı`;
}

/** Turkish reason of a skipped item (after "Üret"). */
export const SKIP_REASON_LABEL: Record<PlanGenerateSkipReason, string> = {
  generating: "zaten üretiliyor",
  generated: "zaten üretilmiş",
  edited: "elle düzenlenmiş",
  approved: "onaylı ya da zamanlanmış",
  published: "yayında",
  no_content: "postu silinmiş",
};

/** "3 post üretime alındı; 2 post atlandı (zaten üretilmiş)." */
export function generateSummary(
  queued: number,
  skipped: readonly { reason: PlanGenerateSkipReason }[],
): string {
  const head = queued > 0 ? `${queued} post üretime alındı` : "Üretilecek post yok";
  if (skipped.length === 0) return `${head}.`;
  const reasons = [...new Set(skipped.map((s) => SKIP_REASON_LABEL[s.reason]))].join(", ");
  return `${head}; ${skipped.length} post atlandı (${reasons}).`;
}

// --- the item form -------------------------------------------------------------------------------

export const CONTENT_TYPES: { value: ContentType; label: string }[] = (
  ["post", "carousel", "story", "reel"] as const
).map((value) => ({ value, label: CONTENT_TYPE_LABEL[value] }));

export interface ItemDraft {
  date: string;
  contentType: ContentType;
  title: string;
  brief: string;
  platforms: Platform[];
  /** A brand template the post is made from (N9; null: designed anew). */
  templateId?: string | null;
}

export function draftOf(item: PlanItem): ItemDraft {
  return {
    date: item.date ?? "",
    contentType: item.contentType,
    title: item.title,
    brief: item.brief,
    platforms: [...item.platforms],
    templateId: item.templateId ?? null,
  };
}

/** A new item's draft: the period's first day, one Instagram post. */
export function newItemDraft(plan: Pick<Plan, "periodStart">): ItemDraft {
  return {
    date: plan.periodStart,
    contentType: "post",
    title: "",
    brief: "",
    platforms: ["instagram"],
  };
}

/** Why the form cannot be saved (null: it can). */
export function draftError(
  draft: ItemDraft,
  plan: Pick<Plan, "periodStart" | "periodEnd">,
): string | null {
  if (!draft.title.trim()) return "Konu boş olamaz.";
  if (draft.title.trim().length > 200) return "Konu en fazla 200 karakter olabilir.";
  if (draft.platforms.length === 0) return "En az bir platform seç.";
  if (draft.date) {
    if (!localDate(draft.date)) return "Tarih geçersiz.";
    if (draft.date < plan.periodStart || draft.date > plan.periodEnd)
      return "Tarih planın ayı içinde olmalı.";
  }
  return null;
}

/** Only the fields that changed (an empty patch: nothing to save). */
export function draftPatch(item: PlanItem, draft: ItemDraft): PlanItemPatch {
  const patch: Record<string, unknown> = {};
  const date = draft.date || null;
  if (date !== item.date) patch.date = date;
  if (draft.contentType !== item.contentType) patch.contentType = draft.contentType;
  if (draft.title.trim() !== item.title) patch.title = draft.title.trim();
  if (draft.brief !== item.brief) patch.brief = draft.brief;
  const same =
    draft.platforms.length === item.platforms.length &&
    draft.platforms.every((p) => item.platforms.includes(p));
  if (!same) patch.platforms = draft.platforms;
  if ((draft.templateId ?? null) !== (item.templateId ?? null))
    patch.templateId = draft.templateId ?? null;
  return patch as PlanItemPatch;
}
