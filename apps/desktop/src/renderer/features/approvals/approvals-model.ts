// Approval requests ("Onay bekleyenler", docs/URETIM-RESIM.md §11–13) as pure values: the
// pending list kept live from `approval.updated`, the check report's short summary, labels and
// tones, and which request replaced a regenerated one. Tested without views.
import type {
  ApprovalCheckReport,
  ApprovalKind,
  ApprovalRequest,
  ApprovalStatus,
} from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  product_image: "Ürün görseli",
  variant: "Varyant",
  product_photo_upgrade: "Ürün fotoğrafı iyileştirme",
};

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: TagTone }> = {
  pending: { label: "Onay bekliyor", tone: "warning" },
  approved: { label: "Onaylandı", tone: "success" },
  rejected: { label: "Reddedildi", tone: "danger" },
  superseded: { label: "Yeniden üretildi", tone: "neutral" },
};

/** Newest first (createdAt, then id for a stable order). */
export function newestFirst(a: ApprovalRequest, b: ApprovalRequest): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * A brand's pending list after `approval` changed: added or replaced while pending (and of the
 * brand), dropped once decided. Unchanged lists are returned as they are.
 */
export function reducePending(
  list: readonly ApprovalRequest[],
  approval: ApprovalRequest,
  brandId: string | null,
): ApprovalRequest[] {
  const keep = approval.status === "pending" && (brandId === null || approval.brandId === brandId);
  const index = list.findIndex((a) => a.id === approval.id);
  if (!keep) return index === -1 ? (list as ApprovalRequest[]) : list.filter((_, i) => i !== index);
  const next =
    index === -1 ? [...list, approval] : list.map((a, i) => (i === index ? approval : a));
  return next.sort(newestFirst);
}

/** Any list (every status) after `approval` changed: replaced in place, or added newest first. */
export function upsertApproval(
  list: readonly ApprovalRequest[],
  approval: ApprovalRequest,
): ApprovalRequest[] {
  const index = list.findIndex((a) => a.id === approval.id);
  if (index === -1) return [...list, approval].sort(newestFirst);
  return list.map((a, i) => (i === index ? approval : a));
}

/** The failed aspects of a report, in its order. */
export function failedItems(report: ApprovalCheckReport | null) {
  return (report?.items ?? []).filter((item) => !item.ok);
}

/**
 * One short line for lists: "Kontrol geçti", "2 sorun: Etiket yazısı, Kapak rengi",
 * "Kontrol çalışmadı".
 */
export function checkSummaryLine(report: ApprovalCheckReport | null): string {
  if (!report) return "Kontrol çalışmadı";
  const failed = failedItems(report);
  if (failed.length === 0) return report.passed ? "Kontrol geçti" : "Kontrol geçmedi";
  const names = failed.map((item) => item.aspect);
  const shown = names.slice(0, 2).join(", ");
  const more = names.length > 2 ? ` +${names.length - 2}` : "";
  return `${failed.length} sorun: ${shown}${more}`;
}

/** Tone of the check line: passed (success), problems (danger), none (neutral). */
export function checkTone(report: ApprovalCheckReport | null): "success" | "danger" | "neutral" {
  if (!report) return "neutral";
  return report.passed && failedItems(report).length === 0 ? "success" : "danger";
}

/**
 * The request "Yeniden üret" made: its pictures come from the regenerate job
 * (`sourceJobId === regenerateJobId`). Null while it is still being made.
 */
export function successorOf(
  approval: ApprovalRequest,
  others: readonly ApprovalRequest[],
): ApprovalRequest | null {
  const job = approval.regenerateJobId;
  if (approval.status !== "superseded" || !job) return null;
  return others.find((a) => a.id !== approval.id && a.sourceJobId === job) ?? null;
}

/** The candidate "Onayla" uses: the picked one when it is a candidate, else the first. */
export function chosenAsset(approval: ApprovalRequest, picked: string | null): string | null {
  if (picked && approval.assetIds.includes(picked)) return picked;
  return approval.assetIds[0] ?? null;
}

/** The outcome line of a decided request ("Onaylandı · 2. seçenek kullanıldı"). */
export function outcomeText(approval: ApprovalRequest): string | null {
  switch (approval.status) {
    case "pending":
      return null;
    case "approved": {
      const at = approval.approvedAssetId
        ? approval.assetIds.indexOf(approval.approvedAssetId)
        : -1;
      if (approval.kind === "product_photo_upgrade") return "Onaylandı; ürünün fotoğrafı değişti.";
      if (approval.assetIds.length > 1 && at >= 0)
        return `Onaylandı; ${at + 1}. seçenek posta yerleşti.`;
      return approval.contentId ? "Onaylandı; görsel posta yerleşti." : "Onaylandı.";
    }
    case "rejected":
      return approval.decisionNote
        ? `Reddedildi: ${approval.decisionNote}`
        : "Reddedildi; görseller medya kütüphanesinde kaldı.";
    case "superseded":
      return "Yerine yenisi üretildi.";
  }
}

/** "Onay bekleyen 3" for the panel tool's badge; nothing at 0. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}
