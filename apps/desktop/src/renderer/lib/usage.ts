// Subscription usage (presence.usage) and the Mac status lines, in Turkish (same wording as
// StudioKit's AssistantStatus).
import type { Job, UsageWindow, WorkerPresence, WorkerUsage } from "@studio/contract";
import { formatReset, percentText } from "./format.ts";

/** From here on the usage ring turns orange ("near the limit"). */
export const WARN_PERCENT = 90;

export function effectivePercent(window: UsageWindow): number {
  if (window.limited) return 100;
  return Math.min(100, Math.max(0, window.usedPercent ?? 0));
}

export interface UsageMeter {
  kind: UsageWindow["kind"];
  title: string;
  percent: number;
  percentText: string;
  resetText: string | null;
  warning: boolean;
  limited: boolean;
}

export function windowTitle(kind: UsageWindow["kind"]): string {
  switch (kind) {
    case "five_hour":
      return "5 saatlik limit";
    case "weekly":
      return "Haftalık · tüm modeller";
    default:
      return "Diğer";
  }
}

export function usageMeters(usage: WorkerUsage | undefined, now: Date = new Date()): UsageMeter[] {
  const order: Record<string, number> = { five_hour: 0, weekly: 1, other: 2 };
  return [...(usage?.windows ?? [])]
    .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3))
    .map((w) => {
      const percent = effectivePercent(w);
      return {
        kind: w.kind,
        title: windowTitle(w.kind),
        percent,
        percentText: w.limited
          ? "Sınırda"
          : w.usedPercent === undefined
            ? "—"
            : percentText(percent),
        resetText: w.resetsAt ? formatReset(w.resetsAt, now) : null,
        warning: w.limited || percent >= WARN_PERCENT,
        limited: w.limited,
      };
    });
}

/** The ring under the composer shows the busiest window. */
export function ringMeter(usage: WorkerUsage | undefined): UsageMeter | null {
  const meters = usageMeters(usage);
  if (meters.length === 0) return null;
  return meters.reduce((a, b) => (b.percent > a.percent ? b : a));
}

export function macLine(presence: WorkerPresence | null | undefined): string {
  if (!presence) return "Mac'e bağlanılıyor";
  if (presence.online) {
    const busy = presence.currentJobs.length;
    if (busy > 0) return `Mac çalışıyor · ${busy} iş`;
    if (presence.queueLength > 0) return `Mac hazır · ${presence.queueLength} iş sırada`;
    return "Mac hazır";
  }
  return "Mac çevrimdışı";
}

export function claudeLine(presence: WorkerPresence | null | undefined): string {
  const claude = presence?.claude;
  if (!claude) return presence?.online ? "Henüz bildirilmedi" : "Mac çevrimdışı";
  switch (claude.status) {
    case "signed_in": {
      const who = [claude.email, claude.plan].filter(Boolean).join(" · ");
      return who ? `Giriş yapıldı · ${who}` : "Giriş yapıldı";
    }
    case "signed_out":
      return "Giriş yapılmadı (Mac'te giriş yap)";
    case "signing_in":
      return "Mac'te tarayıcı girişi bekleniyor";
    case "not_installed":
      return "Claude CLI Mac'te kurulu değil";
    default:
      return claude.detail ?? "Durum okunamadı";
  }
}

export function geminiLine(presence: WorkerPresence | null | undefined): string {
  const gemini = presence?.gemini;
  if (!gemini) return presence?.online ? "Durum bekleniyor" : "Mac çevrimdışı";
  if (gemini.status === "ready") {
    const mode = { api: "API anahtarı", cli: "Gemini CLI", both: "API + CLI", none: "Hazır" }[
      gemini.mode
    ];
    return `Hazır · ${mode}`;
  }
  if (gemini.status === "not_configured")
    return "Yapılandırılmadı (Mac'te GEMINI_API_KEY ya da CLI gerekli)";
  return gemini.detail ?? "Durum okunamadı";
}

/** A connected worker can run chat turns. */
export function canRunChat(presence: WorkerPresence | null | undefined): boolean {
  return (presence?.workers ?? []).some((w) => !w.draining && w.capabilities.includes("chat.turn"));
}

// --- jobs -------------------------------------------------------------------------------------

const JOB_LABELS: Record<string, string> = {
  "content.generate": "Post üretimi",
  "content.render": "Görsel çıktısı",
  "brand.analyze": "Marka analizi",
  "brand.skill_draft": "Skill taslağı",
  "content.check": "Kontroller",
  "image.generate": "AI görsel üretimi",
  "schedule.publish": "Zamanlı yayın",
  "chat.turn": "Sohbet yanıtı",
  "demo.echo": "Deneme işi",
};

export function jobTitle(job: Job): string {
  const payload = job.payload as Record<string, unknown>;
  if (typeof payload.title === "string" && payload.title) return payload.title;
  if (job.type === "demo.echo" && typeof payload.text === "string" && payload.text)
    return payload.text;
  return JOB_LABELS[job.type] ?? job.type;
}

export function jobStatusText(status: Job["status"]): string {
  return (
    {
      queued: "Sırada",
      running: "Çalışıyor",
      succeeded: "Bitti",
      failed: "Başarısız",
      cancelled: "Durduruldu",
    }[status] ?? status
  );
}

export interface JobsBoard {
  running: Job[];
  queued: Job[];
  finished: Job[];
}

export function jobsBoard(jobs: Job[], clearedAt: number | null = null): JobsBoard {
  const byNewest = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    running: byNewest.filter((j) => j.status === "running"),
    queued: byNewest.filter((j) => j.status === "queued"),
    finished: byNewest.filter(
      (j) =>
        (j.status === "succeeded" || j.status === "failed" || j.status === "cancelled") &&
        (clearedAt === null || Date.parse(j.updatedAt) > clearedAt),
    ),
  };
}
