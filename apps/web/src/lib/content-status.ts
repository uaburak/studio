import {
  APPROVABLE_STATUSES,
  type Content,
  type ContentStatus,
  type ContentTransition,
  MANUAL_CONTENT_TRANSITIONS,
  SCHEDULABLE_STATUSES,
  statusIn,
  UNDELETABLE_STATUSES,
  VERSIONABLE_STATUSES,
} from "@studio/contract";
import type { StatusMeta } from "./labels.ts";

/**
 * UI view of the content state machine. The rules themselves come from the
 * contract (`MANUAL_CONTENT_TRANSITIONS` etc.); this module only decides
 * which buttons to show and what they say.
 */

export const CONTENT_STATUS: Record<ContentStatus, StatusMeta> = {
  draft: { label: "Taslak", tone: "neutral", hint: "Üzerinde çalışılıyor." },
  in_review: { label: "İncelemede", tone: "violet", hint: "Onayını bekliyor." },
  approved: { label: "Onaylandı", tone: "good", hint: "Belirli bir sürüm onaylı; zamanlanabilir." },
  scheduled: {
    label: "Zamanlandı",
    tone: "info",
    hint: "Zamanlama kaydı var. Otomatik yayın henüz yok (Faz 3).",
  },
  publishing: { label: "Yayınlanıyor", tone: "warn" },
  published: { label: "Yayınlandı", tone: "good" },
  failed: { label: "Hata", tone: "bad", hint: "Yayın başarısız oldu." },
};

/** Lifecycle order for the progress strip. */
export const CONTENT_FLOW: ContentStatus[] = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
];

export type ManualTarget = ContentTransition["to"];

export interface TransitionAction {
  to: ManualTarget;
  label: string;
  /** Destructive-ish actions (revoking approval) get a quieter style + confirm. */
  intent: "primary" | "secondary" | "danger";
  confirm?: string;
}

const ACTION_COPY: Partial<
  Record<`${ContentStatus}->${ManualTarget}`, Omit<TransitionAction, "to">>
> = {
  "draft->in_review": { label: "İncelemeye gönder", intent: "secondary" },
  "in_review->draft": { label: "Taslağa geri al", intent: "secondary" },
  "approved->draft": {
    label: "Onayı geri çek",
    intent: "danger",
    confirm: "Onay kaldırılacak ve içerik taslağa dönecek.",
  },
  "failed->draft": { label: "Taslağa döndür", intent: "secondary" },
  "failed->approved": { label: "Onaylıya döndür", intent: "secondary" },
};

/**
 * Buttons for the transitions a user may request in `status`. Review needs a
 * version to look at (the API answers 409 otherwise), so it is hidden until then.
 */
export function manualTransitions(status: ContentStatus, hasVersion = true): TransitionAction[] {
  const targets = MANUAL_CONTENT_TRANSITIONS[status] as readonly ManualTarget[];
  return targets
    .filter((to) => hasVersion || to !== "in_review")
    .map((to) => {
      const copy = ACTION_COPY[`${status}->${to}`] ?? {
        label: CONTENT_STATUS[to].label,
        intent: "secondary" as const,
      };
      return { to, ...copy };
    });
}

export interface ContentCapabilities {
  /** Approve-by-hash is possible (status allows it and a version exists). */
  canApprove: boolean;
  /** A schedule may be created: status allows it and the approval matches the current version. */
  canSchedule: boolean;
  canDelete: boolean;
  canAddVersion: boolean;
  /** Caption and target platforms are frozen. */
  captionLocked: boolean;
  /** Editing caption/platforms would revoke the existing approval. */
  captionEditRevokesApproval: boolean;
  /** Why approval is not possible (for a disabled-button hint). */
  approveBlockedReason: string | null;
  scheduleBlockedReason: string | null;
}

export function contentCapabilities(content: Content): ContentCapabilities {
  const { status, currentVersion, approval } = content;
  const approvableStatus = statusIn(status, APPROVABLE_STATUSES);
  const approvalMatches =
    approval !== null &&
    currentVersion !== null &&
    approval.versionId === currentVersion.id &&
    approval.contentHash === currentVersion.contentHash;

  let approveBlockedReason: string | null = null;
  if (!currentVersion) approveBlockedReason = "Onaylanacak bir sürüm yok.";
  else if (!approvableStatus)
    approveBlockedReason =
      status === "approved" || status === "scheduled"
        ? "Güncel sürüm zaten onaylı."
        : `${CONTENT_STATUS[status].label} durumundaki içerik onaylanamaz.`;

  let scheduleBlockedReason: string | null = null;
  if (!statusIn(status, SCHEDULABLE_STATUSES))
    scheduleBlockedReason = "Zamanlamak için önce güncel sürümü onaylayın.";
  else if (!approvalMatches) scheduleBlockedReason = "Onay güncel sürümle eşleşmiyor.";
  else if (content.targetPlatforms.length === 0)
    scheduleBlockedReason = "Önce en az bir hedef platform seçin.";

  return {
    canApprove: approveBlockedReason === null,
    canSchedule: scheduleBlockedReason === null,
    canDelete: !statusIn(status, UNDELETABLE_STATUSES),
    canAddVersion: statusIn(status, VERSIONABLE_STATUSES),
    captionLocked: status === "publishing" || status === "published",
    captionEditRevokesApproval:
      approval !== null && status !== "publishing" && status !== "published",
    approveBlockedReason,
    scheduleBlockedReason,
  };
}

/** Short form of a SHA-256 for display: first 8 + last 4. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}
