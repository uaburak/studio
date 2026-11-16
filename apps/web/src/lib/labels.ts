import type {
  AssetKind,
  AssetSource,
  BrandProfileStatus,
  ContentType,
  ContentVersionOrigin,
  JobStatus,
  JobType,
  Platform,
  PublishLogStatus,
  ScheduleStatus,
  SocialAccountStatus,
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
    hint: "Otomatik yayın henüz yok (Faz 3). Bu kayıt yalnızca planı tutar; şu an hiçbir şey paylaşılmaz.",
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
    hint: "Hesap kayıtlı; yetkilendirme (Faz 3) henüz yapılmadı.",
  },
  connected: { label: "Bağlı", tone: "good" },
  needs_reauth: { label: "Yeniden bağlanmalı", tone: "bad" },
  disabled: { label: "Devre dışı", tone: "neutral" },
};

export const PROFILE_STATUS: Record<BrandProfileStatus, StatusMeta> = {
  draft: { label: "Taslak", tone: "warn" },
  approved: { label: "Onaylı", tone: "good" },
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
