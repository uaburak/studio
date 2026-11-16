import type {
  AgentEffort,
  AgentModel,
  AssetKind,
  AssetSource,
  BrandProfileStatus,
  ClaudeAccountStatus,
  ContentType,
  ContentVersionOrigin,
  GeminiAccountStatus,
  ImageSlotExpectation,
  JobStatus,
  JobType,
  PlanStatus,
  Platform,
  PublishLogStatus,
  ScheduleStatus,
  SocialAccountStatus,
  TokenHealthStatus,
} from "@studio/contract";

/** Visual tone of a status; maps to the `.tint-*` classes in index.css. */
export type Tone = "neutral" | "info" | "good" | "warn" | "bad" | "accent" | "violet";

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Short explanation shown in tooltips / detail panels. */
  hint?: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  post: "Post",
  carousel: "Carousel",
  story: "Story",
  reel: "Reels",
};

export const CONTENT_TYPE_HINTS: Record<ContentType, string> = {
  post: "Tek görsel",
  carousel: "2–20 slayt",
  story: "Dikey, tek kare",
  reel: "Video",
};

export const VERSION_ORIGIN_LABELS: Record<ContentVersionOrigin, string> = {
  generated: "Üretildi",
  manual_edit: "Elle düzenlendi",
  ai_edit: "AI düzeltmesi",
};

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  image: "Görsel",
  video: "Video",
  audio: "Ses",
  document: "Belge",
  font: "Font",
  logo: "Logo",
  other: "Diğer",
};

export const ASSET_SOURCE_LABELS: Record<AssetSource, string> = {
  upload: "Yükleme",
  generated: "Üretim",
  ingested: "İçe aktarım",
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  "chat.turn": "Sohbet turu",
  "content.generate": "İçerik üretimi",
  "content.render": "Render",
  "brand.analyze": "Marka analizi",
  "image.generate": "Görsel üretimi",
  "schedule.publish": "Zamanlı yayın",
  "demo.echo": "Deneme (echo)",
};

export const JOB_STATUS: Record<JobStatus, StatusMeta> = {
  queued: { label: "Sırada", tone: "neutral", hint: "Worker'ın almasını bekliyor." },
  running: { label: "Çalışıyor", tone: "info" },
  succeeded: { label: "Tamamlandı", tone: "good" },
  failed: { label: "Başarısız", tone: "bad" },
  cancelled: { label: "İptal edildi", tone: "neutral" },
};

export const SCHEDULE_STATUS: Record<ScheduleStatus, StatusMeta> = {
  pending: {
    label: "Zamanlandı",
    tone: "info",
    hint: "Zamanı geldiğinde bağlı hesaptan otomatik yayınlanır.",
  },
  publishing: { label: "Yayınlanıyor", tone: "warn" },
  published: { label: "Yayınlandı", tone: "good" },
  failed: { label: "Yayın hatası", tone: "bad" },
  cancelled: { label: "İptal edildi", tone: "neutral" },
};

export const PUBLISH_LOG_STATUS: Record<PublishLogStatus, StatusMeta> = {
  started: { label: "Başladı", tone: "info" },
  succeeded: { label: "Başarılı", tone: "good" },
  failed: { label: "Başarısız", tone: "bad" },
};

export const ACCOUNT_STATUS: Record<SocialAccountStatus, StatusMeta> = {
  pending: {
    label: "Bağlantı bekliyor",
    tone: "warn",
    hint: "Hesap kayıtlı; yayın için token girin ya da platform bağlantısını tamamlayın.",
  },
  connected: { label: "Bağlı", tone: "good" },
  needs_reauth: { label: "Yeniden bağlanmalı", tone: "bad" },
  disabled: { label: "Devre dışı", tone: "neutral" },
};

export const TOKEN_HEALTH_STATUS: Record<TokenHealthStatus, StatusMeta> = {
  valid: { label: "Token sağlıklı", tone: "good" },
  expiring_soon: {
    label: "Süresi yaklaşıyor",
    tone: "warn",
    hint: "Token yakında sona erecek; yeniden yetkilendirin.",
  },
  invalid: {
    label: "Token geçersiz",
    tone: "bad",
    hint: "Token süresi dolmuş ya da iptal edilmiş.",
  },
  missing_scopes: {
    label: "Eksik izin",
    tone: "bad",
    hint: "Yayın için gerekli platform izinleri eksik.",
  },
  unchecked: { label: "Kontrol edilmedi", tone: "neutral" },
};

export const PROFILE_STATUS: Record<BrandProfileStatus, StatusMeta> = {
  draft: { label: "Taslak", tone: "warn" },
  approved: { label: "Onaylı", tone: "good" },
};

export const AGENT_MODEL_OPTIONS: readonly { value: AgentModel; label: string; group: string }[] = [
  { value: "gemini-flash-lite", label: "Gemini Flash-Lite", group: "Gemini" },
  { value: "gemini-flash", label: "Gemini Flash", group: "Gemini" },
  { value: "gemini-pro", label: "Gemini Pro", group: "Gemini" },
  { value: "opus", label: "Opus", group: "Claude" },
  { value: "sonnet", label: "Sonnet", group: "Claude" },
  { value: "haiku", label: "Haiku", group: "Claude" },
];

export const AGENT_MODEL_LABELS: Record<AgentModel, string> = {
  "gemini-flash-lite": "Gemini Flash-Lite",
  "gemini-flash": "Gemini Flash",
  "gemini-pro": "Gemini Pro",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export const AGENT_EFFORT_OPTIONS: readonly { value: AgentEffort; label: string }[] = [
  { value: "low", label: "Düşük" },
  { value: "medium", label: "Orta" },
  { value: "high", label: "Yüksek" },
  { value: "xhigh", label: "Çok yüksek" },
];

export const AGENT_EFFORT_LABELS: Record<AgentEffort, string> = {
  low: "Düşük",
  medium: "Orta",
  high: "Yüksek",
  xhigh: "Çok yüksek",
};

export const PLAN_STATUS: Record<PlanStatus, StatusMeta> = {
  draft: { label: "Taslak", tone: "neutral" },
  proposed: { label: "Önerildi", tone: "accent" },
  accepted: { label: "Kabul edildi", tone: "good" },
  rejected: { label: "Reddedildi", tone: "bad" },
  superseded: { label: "Yenilendi", tone: "neutral" },
};

export const IMAGE_SLOT_LABELS: Record<ImageSlotExpectation, string> = {
  none: "Görsel yok",
  user_upload: "Fotoğraf yuvası",
  ai_generate: "AI görsel",
};

export const CLAUDE_STATUS_LABELS: Record<ClaudeAccountStatus, StatusMeta> = {
  signed_in: { label: "Claude bağlı", tone: "good" },
  signing_in: { label: "Giriş yapılıyor…", tone: "warn" },
  signed_out: { label: "Claude oturumu kapalı", tone: "warn" },
  not_installed: { label: "Claude CLI kurulu değil", tone: "bad" },
  error: { label: "Claude hatası", tone: "bad" },
};

export const GEMINI_STATUS_LABELS: Record<GeminiAccountStatus, StatusMeta> = {
  ready: { label: "Gemini hazır", tone: "good" },
  not_configured: { label: "Gemini yapılandırılmadı", tone: "warn" },
  error: { label: "Gemini hatası", tone: "bad" },
};

export const LANGUAGE_OPTIONS = [
  { value: "tr", label: "Türkçe" },
  { value: "en", label: "İngilizce" },
  { value: "de", label: "Almanca" },
] as const;

export function languageLabel(tag: string): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === tag)?.label ?? tag;
}

/** Recommended caption length per platform (characters). */
export const CAPTION_LIMITS: Record<Platform, number> = {
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
};
