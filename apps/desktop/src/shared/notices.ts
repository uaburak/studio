// What a finished job says in a macOS notification, and what its click opens. Shared by the
// main process (which posts every job / publish / consent notice, A8) and the renderer (job
// titles in the jobs pane). Pure, and loose about the job's shape (the main process reads the
// stream without the contract's runtime).
import type { NoticeInput } from "./ipc.ts";

export const JOB_LABELS: Record<string, string> = {
  "content.generate": "Post üretimi",
  "content.render": "Görsel çıktısı",
  "brand.analyze": "Marka analizi",
  "brand.skill_draft": "Skill taslağı",
  "content.check": "Kontroller",
  "canvas.read": "Tuval okuma",
  "canvas.apply": "Tuval düzenlemesi",
  "canvas.create": "Boş tuval",
  "content.details": "Post bilgileri",
  "image.generate": "AI görsel üretimi",
  "schedule.publish": "Zamanlı yayın",
  "chat.turn": "Sohbet yanıtı",
  "demo.echo": "Deneme işi",
  "media.analyze": "Görsel etiketleme",
  "insights.sync": "İstatistik eşitleme",
  "comments.sync": "Yorum eşitleme",
  "comments.suggest": "Yanıt önerisi",
};

export interface JobLike {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  brandId?: string | undefined;
  error?: string | undefined;
  /** The result (only read loosely: e.g. a product picture's label check, U9). */
  output?: unknown;
}

/** U9: the label check of a finished product picture when it is not "ok" (its Turkish message). */
export function labelWarning(job: Pick<JobLike, "type" | "output">): string | null {
  if (job.type !== "image.generate") return null;
  const check = (job.output as { labelCheck?: { status?: unknown; message?: unknown } } | null)
    ?.labelCheck;
  if (!check || check.status === "ok" || typeof check.message !== "string") return null;
  return check.message;
}

export function jobTitle(job: Pick<JobLike, "type" | "payload">): string {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.title === "string" && payload.title) return payload.title;
  if (job.type === "demo.echo" && typeof payload.text === "string" && payload.text)
    return payload.text;
  return JOB_LABELS[job.type] ?? job.type;
}

/** Jobs whose end is worth a notification (besides chat replies). */
const NOTICE_TYPES = new Set([
  "content.generate",
  "content.render",
  "brand.analyze",
  "brand.skill_draft",
  "image.generate",
  "schedule.publish",
]);

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function conversationIdOf(job: Pick<JobLike, "payload">): string | null {
  const id = (job.payload as { conversationId?: unknown } | null)?.conversationId;
  return typeof id === "string" && id ? id : null;
}

/** Where a click on a job's notice goes (a renderer route key, see app-store `parseRoute`). */
export function noticeRoute(job: JobLike): string | undefined {
  switch (job.type) {
    case "chat.turn": {
      const id = conversationIdOf(job);
      return id ? `c:${id}` : undefined;
    }
    case "schedule.publish":
      return "calendar";
    case "content.generate":
    case "content.render":
    case "content.details":
      return "posts";
    case "image.generate":
      return "media";
    case "brand.analyze":
      return job.brandId ? `brand:${job.brandId}/profile` : undefined;
    case "brand.skill_draft":
      return job.brandId ? `brand:${job.brandId}/kit` : undefined;
    case "comments.sync":
    case "comments.suggest":
      return "comments";
    case "insights.sync":
      return "performance";
    default:
      return undefined;
  }
}

/**
 * New comments read by a finished `comments.sync` (N16): one comment is quoted, several are
 * counted; a click opens Yorumlar. Null when nothing new came (or the job did not succeed).
 * Same text as the contract's `newCommentsNotice` (the main process reads jobs loosely).
 */
export function commentsNotice(job: JobLike): NoticeInput | null {
  if (job.type !== "comments.sync" || job.status !== "succeeded") return null;
  const out = (job.output ?? {}) as { newComments?: unknown; sample?: unknown };
  const count = typeof out.newComments === "number" ? out.newComments : 0;
  if (count <= 0) return null;
  const sample = out.sample as { author?: unknown; text?: unknown } | null | undefined;
  if (count === 1 && sample && typeof sample.text === "string") {
    const who = typeof sample.author === "string" && sample.author ? `${sample.author}: ` : "";
    const text = sample.text.length > 120 ? `${sample.text.slice(0, 117)}…` : sample.text;
    return {
      id: `comments-${job.id}`,
      title: "Yeni yorum",
      body: `${who}${text}`,
      route: "comments",
    };
  }
  return {
    id: `comments-${job.id}`,
    title: `${count} yeni yorum`,
    body: "Yorumlar sayfasında yanıtlayabilirsiniz.",
    route: "comments",
  };
}

/**
 * The notice for a job that just finished (null: not worth a notification). `title` is the
 * conversation's title for chat replies, else `jobTitle(job)`.
 */
export function finishedNotice(job: JobLike, title: string): NoticeInput | null {
  if (job.type === "comments.sync") return commentsNotice(job);
  const route = noticeRoute(job);
  if (job.type === "chat.turn") {
    if (job.status !== "succeeded") return null;
    return {
      id: `reply-${job.id}`,
      title: "Yanıt hazır",
      body: title,
      ...(route ? { route } : {}),
    };
  }
  if (!NOTICE_TYPES.has(job.type) || !TERMINAL.has(job.status)) return null;
  if (job.status === "cancelled") return null;
  const ok = job.status === "succeeded";
  if (job.type === "schedule.publish") {
    return {
      id: `job-${job.id}-${job.status}`,
      title: ok ? "Post yayınlandı" : "Yayın başarısız",
      body: ok ? title : `${title}: ${job.error ?? "Ayrıntılar Takvim'de."}`,
      ...(route ? { route } : {}),
    };
  }
  const warning = ok ? labelWarning(job) : null;
  return {
    id: `job-${job.id}-${job.status}`,
    title: ok
      ? warning
        ? `${title} bitti, etiketi kontrol et`
        : `${title} bitti`
      : `${title} başarısız`,
    body: ok
      ? (warning ?? "Sonuç Studio'da hazır.")
      : (job.error ?? "Ayrıntılar Arka plan işleri'nde."),
    ...(route ? { route } : {}),
  };
}

// --- Claude's limit (S7, mode "Sor") ------------------------------------------------------------

/** Notice route of Ayarlar → Yapay zekâ (the page opens settings at that section). */
export const AI_SETTINGS_ROUTE = "settings:ai";

interface ClaudeLimitLike {
  resetsAt?: unknown;
  mode?: unknown;
  decision?: unknown;
  waiting?: unknown;
}

/**
 * Presence `claude.limit` waiting for the owner's answer (mode "Sor", no decision, work
 * waiting): one notice per limit window; a click opens Ayarlar → Yapay zekâ. Null otherwise.
 */
export function claudeLimitNotice(presence: unknown): NoticeInput | null {
  const limit = (presence as { claude?: { limit?: ClaudeLimitLike | null } } | null)?.claude?.limit;
  if (limit?.mode !== "ask" || limit.decision != null) return null;
  const waiting = typeof limit.waiting === "number" ? limit.waiting : 0;
  if (waiting <= 0) return null;
  const resets = typeof limit.resetsAt === "string" ? limit.resetsAt : "now";
  return {
    id: `claude-limit:${resets}`,
    title: "Claude sınırı doldu",
    body: `${waiting} iş cevabını bekliyor: Gemini ile devam et ya da sınırı bekle (Ayarlar → Yapay zekâ).`,
    route: AI_SETTINGS_ROUTE,
  };
}

// --- waiting on the user (consent / question cards) ------------------------------------------

interface PartLike {
  type?: unknown;
  consentId?: unknown;
  title?: unknown;
  state?: unknown;
  questionId?: unknown;
  prompt?: unknown;
  answer?: unknown;
}

/** A card of the agent that waits for the user (a pending consent, an unanswered question). */
export function waitingNotice(
  conversationId: string,
  conversationTitle: string,
  messageId: string,
  part: PartLike,
): NoticeInput | null {
  const name = conversationTitle || "Sohbet";
  const route = `c:${conversationId}`;
  if (part.type === "consent" && part.state === "pending" && typeof part.consentId === "string") {
    return {
      id: `consent:${messageId}:${part.consentId}`,
      title: "Onayın bekleniyor",
      body: `${name}: ${typeof part.title === "string" ? part.title : "İzin isteniyor"}`,
      route,
    };
  }
  if (
    part.type === "question" &&
    (part.answer === null || part.answer === undefined) &&
    typeof part.questionId === "string"
  ) {
    return {
      id: `question:${messageId}:${part.questionId}`,
      title: "Bir sorusu var",
      body: `${name}: ${typeof part.prompt === "string" ? part.prompt : "Yanıtını bekliyor"}`,
      route,
    };
  }
  return null;
}

// --- approval requests ("Onay bekleyenler", docs/URETIM-RESIM.md §11–13) ------------------------

/** An `ApprovalRequest` read loosely (the main process has no contract runtime). */
export interface ApprovalLike {
  id: string;
  brandId: string;
  kind: string;
  status: string;
  contentId?: string | null | undefined;
  productId?: string | null | undefined;
  conversationId?: string | null | undefined;
  messageId?: string | null | undefined;
  checkReport?: unknown;
  createdAt?: string | undefined;
}

/** A pending request older than this is not news (it was listed long ago). */
export const APPROVAL_FRESH_MS = 30 * 60_000;

/** Notice route prefixes: a chat message (`m:<conversationId>/<messageId>`), a brand's list. */
export const MESSAGE_ROUTE_PREFIX = "m:";
export const APPROVALS_ROUTE_PREFIX = "approvals:";

const APPROVAL_KIND_LABELS: Record<string, string> = {
  product_image: "Ürün görseli",
  variant: "Varyant",
  product_photo_upgrade: "Ürün fotoğrafı iyileştirme",
};

export function approvalNoticeTitle(kind: string): string {
  if (kind === "product_photo_upgrade") return "Ürün fotoğrafı iyileştirildi";
  if (kind === "variant") return "Onay bekleyen varyant";
  return "Onay bekleyen görsel";
}

/** The AI check in a notice: "Kontrol temiz", "2 sorun: Etiket yazısı, Kapak". */
export function approvalCheckSummary(report: unknown): string {
  if (!report || typeof report !== "object") return "Kontrol yapılmadı";
  const r = report as { passed?: unknown; items?: unknown; summary?: unknown };
  const items = Array.isArray(r.items) ? (r.items as { aspect?: unknown; ok?: unknown }[]) : [];
  const failed = items
    .filter((item) => item?.ok === false)
    .map((item) => (typeof item.aspect === "string" ? item.aspect : "?"));
  if (failed.length > 0) return `${failed.length} sorun: ${failed.join(", ")}`;
  if (r.passed !== false) return "Kontrol temiz";
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  return summary ? summary.slice(0, 140) : "Kontrol sorun buldu";
}

/** Where a click goes: the request's chat card, else the brand's "Onay bekleyenler". */
export function approvalRoute(approval: ApprovalLike): string {
  if (approval.conversationId) {
    return approval.messageId
      ? `${MESSAGE_ROUTE_PREFIX}${approval.conversationId}/${approval.messageId}`
      : `c:${approval.conversationId}`;
  }
  return `${APPROVALS_ROUTE_PREFIX}${approval.brandId}`;
}

/** A new pending request's notice (null once decided). `subject`: the post's or product's name. */
export function approvalNotice(
  approval: ApprovalLike,
  subject?: string | null,
): NoticeInput | null {
  if (approval.status !== "pending") return null;
  const name = subject?.trim() || APPROVAL_KIND_LABELS[approval.kind] || "Görsel";
  return {
    id: `approval:${approval.id}`,
    title: approvalNoticeTitle(approval.kind),
    body: `${name} · ${approvalCheckSummary(approval.checkReport)}`,
    route: approvalRoute(approval),
  };
}

/** `m:<conversationId>/<messageId>` → its parts (null for other routes). */
export function parseMessageRoute(
  route: string,
): { conversationId: string; messageId: string } | null {
  if (!route.startsWith(MESSAGE_ROUTE_PREFIX)) return null;
  const rest = route.slice(MESSAGE_ROUTE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { conversationId: rest.slice(0, slash), messageId: rest.slice(slash + 1) };
}
