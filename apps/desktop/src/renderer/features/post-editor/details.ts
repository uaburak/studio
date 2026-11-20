// "Bilgileri üret" (Faz 2): a `content.details` job writes the post's caption, hashtags, title and
// publish details from its design; the design is never touched (no version). Pure helpers for
// the editor's Açıklama tab (ui/details-generator.tsx).
import {
  type ContentDetailField,
  ContentDetailsOutput,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";

const FIELD_LABELS: Record<ContentDetailField, string> = {
  title: "başlık",
  caption: "açıklama ve hashtag'ler",
  altText: "alternatif metinler",
  firstComment: "ilk yorum",
};

/** The post's latest "Bilgileri üret" job (the live list is newest first or not: by time). */
export function latestDetailsJob(jobs: readonly Job[], contentId: string): Job | null {
  let best: Job | null = null;
  for (const j of jobs) {
    if (j.type !== "content.details" || j.contentId !== contentId) continue;
    if (!best || j.createdAt > best.createdAt) best = j;
  }
  return best;
}

export type DetailsState =
  | { kind: "idle" }
  | { kind: "running"; message: string; progress: number | null }
  | { kind: "done"; message: string; notes: string[] }
  | { kind: "failed"; message: string };

/** What the editor says about a "Bilgileri üret" job. */
export function detailsState(job: Job | null): DetailsState {
  if (!job) return { kind: "idle" };
  if (!isTerminalJobStatus(job.status)) {
    const msg = (job as { progressMessage?: string }).progressMessage;
    return {
      kind: "running",
      message: msg || (job.status === "queued" ? "Sırada…" : "Bilgiler yazılıyor…"),
      progress: typeof job.progress === "number" ? job.progress : null,
    };
  }
  if (job.status === "failed") return { kind: "failed", message: job.error ?? "Üretilemedi." };
  if (job.status === "cancelled") return { kind: "failed", message: "İptal edildi." };
  const parsed = ContentDetailsOutput.safeParse(job.output ?? {});
  if (!parsed.success) return { kind: "done", message: "Bilgiler yazıldı.", notes: [] };
  const out = parsed.data;
  return {
    kind: "done",
    message: out.written.length
      ? `Yazıldı: ${out.written.map((f) => FIELD_LABELS[f]).join(", ")}. Tasarım değişmedi.`
      : "Değişen bir bilgi olmadı; tasarım değişmedi.",
    notes: out.notes,
  };
}

/** Why the button can't be used now (null: it can). */
export function detailsBlocker(o: {
  status: string;
  hasVersion: boolean;
  running: boolean;
  captionDirty: boolean;
}): string | null {
  if (o.status === "published" || o.status === "publishing")
    return "Yayınlanan postun bilgileri değiştirilemez.";
  if (!o.hasVersion) return "Önce bir tasarım olmalı.";
  if (o.running) return "Bilgiler yazılıyor.";
  if (o.captionDirty) return "Önce açıklamadaki değişikliği kaydet ya da vazgeç.";
  return null;
}
