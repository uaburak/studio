// When the canvas opens read only (E3) and what unlocks it. Editing a post that is approved or
// scheduled would take its approval away and cancel its schedules once a version is made, so the
// canvas opens locked and "Düzenle" says so first (listing the accounts) — then it unlocks.
// Publishing and published posts never unlock (a published one can be duplicated); an older
// version is looked at, not edited ("Bu sürüme dön" makes it current, explicitly: E19); while an
// AI run or a job may make a new version the canvas waits. A version the SVG engine made is
// edited only from the chat (docs/URETIM-RESIM.md, decision 3): the canvas only shows it.
import {
  type ContentStatus,
  isSvgSlideHtml,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";
import {
  activeVersion,
  changesVersion,
  type EditorSnapshot,
  isViewingCurrent,
} from "../post-detail/editor.ts";

export type EditLock =
  | { kind: "approval"; status: "approved" | "scheduled"; message: string }
  | { kind: "publishing"; message: string }
  | { kind: "published"; message: string }
  | { kind: "old-version"; shown: number; current: number | null; message: string }
  | { kind: "busy"; message: string }
  | { kind: "svg"; message: string };

/**
 * A job of this post that may make a new version (a revision, a render with edits, the agent's
 * canvas edit — from any conversation or the iPhone).
 */
export function versionJobRunning(jobs: readonly Job[], contentId: string): boolean {
  return jobs.some(
    (j) =>
      j.contentId === contentId &&
      !isTerminalJobStatus(j.status) &&
      (j.type === "content.generate" ||
        j.type === "canvas.apply" ||
        j.type === "canvas.create" ||
        (j.type === "content.render" &&
          Array.isArray((j.payload as { patches?: unknown } | null)?.patches))),
  );
}

/** Why the canvas is read only now (null: it can be edited). */
export function editLock(
  s: EditorSnapshot,
  o: {
    /** The post's Sohbet is answering (it may make a version). */
    chatWorking?: boolean;
    /** A job of the post may make a version. */
    jobRunning?: boolean;
    /** "Düzenle" was confirmed for this approval. */
    unlocked?: boolean;
  } = {},
): EditLock | null {
  const status: ContentStatus = s.content.status;
  if (status === "published")
    return {
      kind: "published",
      message: "Yayınlandı; tuval yalnızca görüntülenir. Değiştirmek için kopyasını oluştur.",
    };
  if (status === "publishing")
    return { kind: "publishing", message: "Şu an yayınlanıyor; bu sırada düzenlenemez." };
  if (changesVersion(s.activity) || o.chatWorking || o.jobRunning) {
    const message =
      s.activity.kind === "restoring"
        ? "Sürüm geri yükleniyor…"
        : s.activity.kind === "revising" || o.chatWorking || o.jobRunning
          ? "AI düzenliyor; bitince tuval yeni sürümle açılır."
          : "Değişiklik işleniyor…";
    return { kind: "busy", message };
  }
  const shown = activeVersion(s)?.version;
  if (shown !== undefined && !isViewingCurrent(s)) {
    const current = s.content.currentVersion?.version ?? null;
    return {
      kind: "old-version",
      shown,
      current,
      message: `Eski bir sürüme (v${shown}) bakıyorsun; düzenlenmez.`,
    };
  }
  // Made by the SVG engine (Faz 3): its SVG is the design, edited only from the chat.
  if (activeVersion(s)?.slides.some((sl) => isSvgSlideHtml(sl.html)))
    return {
      kind: "svg",
      message: "SVG motoruyla üretildi; tuvalde düzenlenmez. Değişikliği sohbetten iste.",
    };
  if ((status === "approved" || status === "scheduled") && !o.unlocked)
    return {
      kind: "approval",
      status,
      message:
        status === "scheduled" ? "Zamanlanmış post; tuval kilitli." : "Onaylı post; tuval kilitli.",
    };
  return null;
}

/** What "Düzenle" warns about before it unlocks an approved or scheduled post. */
export function unlockWarning(
  status: "approved" | "scheduled",
  schedules: readonly string[],
): string {
  const approval =
    "Değişiklikler bu Mac'te taslak olarak tutulur; bir sürüm kaydedildiğinde (⌘S, onay, zamanlama, sohbet mesajı ya da değişiklikle postu kapatınca) onay kalkar ve post yeniden onay ister.";
  if (status !== "scheduled" || schedules.length === 0) return approval;
  return `${approval} Şu zamanlamalar da iptal edilir: ${schedules.join("; ")}.`;
}
