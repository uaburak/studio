// Ayarlar: sections in sidebar order (groups split by hairlines), every fixed row's title and
// description, and the search across sections and table rows. Pure (the AppKit app's
// SettingsCatalog / SettingsSearch / SettingsNavigation), so the words on screen and the words
// search matches are the same.

export type SectionId =
  | "ai"
  | "usage"
  | "appearance"
  | "notifications"
  | "brands"
  | "accounts"
  | "publishing"
  | "devices"
  | "advanced"
  | "about";

export interface SectionInfo {
  id: SectionId;
  title: string;
  /** Sidebar group; a hairline sits between groups. */
  group: number;
  /** Extra words a search for the whole section may use. */
  keywords: string;
}

export const SECTIONS: SectionInfo[] = [
  {
    id: "ai",
    title: "Yapay zekâ",
    group: 0,
    keywords: "claude gemini codex openai gpt antigravity model efor",
  },
  { id: "usage", title: "Kullanım", group: 0, keywords: "limit kota sınır yüzde harcama bütçe" },
  { id: "appearance", title: "Görünüm", group: 1, keywords: "tema açık koyu karanlık mod" },
  { id: "notifications", title: "Bildirimler", group: 1, keywords: "bildirim uyarı" },
  { id: "brands", title: "Markalar", group: 2, keywords: "marka brand" },
  {
    id: "accounts",
    title: "Hesaplar",
    group: 2,
    keywords: "instagram facebook linkedin meta sosyal",
  },
  { id: "publishing", title: "Yayın", group: 2, keywords: "bulut yayıncı zamanlama" },
  { id: "devices", title: "Cihazlar", group: 3, keywords: "telefon iphone eşleştir bağla qr kod" },
  {
    id: "advanced",
    title: "Gelişmiş",
    group: 3,
    keywords: "mac sunucusu sunucu api worker ağ tünel adres port",
  },
  { id: "about", title: "Hakkında", group: 3, keywords: "sürüm versiyon" },
];

/** First open (nothing remembered yet). */
export const DEFAULT_SECTION: SectionId = "brands";

export function sectionInfo(id: SectionId): SectionInfo {
  return SECTIONS.find((s) => s.id === id) ?? (SECTIONS[0] as SectionInfo);
}

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && SECTIONS.some((s) => s.id === value);
}

/** Sections split into sidebar groups, in order. */
export function sectionGroups(): SectionInfo[][] {
  const groups: SectionInfo[][] = [];
  for (const section of SECTIONS) {
    const last = groups.at(-1);
    if (last && last[0]?.group === section.group) last.push(section);
    else groups.push([section]);
  }
  return groups;
}

/** The section ⌘, opens: a deep link wins, then the remembered one. */
export function initialSection(requested: SectionId | null, remembered: string): SectionId {
  if (requested) return requested;
  return isSectionId(remembered) ? remembered : DEFAULT_SECTION;
}

// --- rows -------------------------------------------------------------------------------------------

export interface SettingsItem {
  id: string;
  section: SectionId;
  title: string;
  detail: string;
  keywords: string;
}

function item(
  id: string,
  section: SectionId,
  title: string,
  detail = "",
  keywords = "",
): SettingsItem {
  return { id, section, title, detail, keywords };
}

/** Every fixed row of the sheet (the panes build their rows from these). */
export const ITEMS = {
  // Markalar
  newBrand: item(
    "brands.new",
    "brands",
    "Yeni marka",
    "Ad, dil ve ses tonuyla yeni bir marka oluştur.",
    "ekle oluştur",
  ),
  // Kullanım
  claudeUsage: item(
    "usage.claude",
    "usage",
    "Claude aboneliği",
    "Claude Code'un bildirdiği 5 saatlik ve haftalık kullanım.",
    "haftalık sıfırlanma",
  ),
  geminiSpend: item(
    "usage.gemini",
    "usage",
    "Gemini API harcaması",
    "Her Gemini çağrısının token sayısı × fiyat tablosu (tahmini, USD).",
    "maliyet dolar fatura token gemini",
  ),
  geminiBudget: item(
    "usage.geminiBudget",
    "usage",
    "Aylık Gemini bütçesi",
    "Kalan bütçe ve %80'de uyarı için (USD). Boş bırakılırsa bütçe yok.",
    "bütçe limit dolar uyarı",
  ),
  geminiCredit: item(
    "usage.geminiCredit",
    "usage",
    "Kalan kredi",
    "Gemini API kalan krediyi bildirmez; AI Studio faturalandırma sayfasından bakılır.",
    "kredi bakiye faturalandırma aistudio",
  ),
  // Görünüm
  theme: item(
    "appearance.theme",
    "appearance",
    "Tema",
    "Sistem, macOS ayarını izler.",
    "dark light",
  ),
  ownerName: item(
    "appearance.name",
    "appearance",
    "Adın",
    "Kenar çubuğunda görünür. Boş bırakırsan Claude hesabındaki adın kullanılır.",
    "isim ad profil selam",
  ),
  // Yapay zekâ
  defaultModel: item(
    "ai.model",
    "ai",
    "Varsayılan model",
    "Yeni sohbetler bu modelle başlar; sohbette değiştirilebilir.",
    "opus sonnet haiku flash pro",
  ),
  defaultEffort: item(
    "ai.effort",
    "ai",
    "Varsayılan efor",
    "Yeni sohbetlerde düşünme düzeyi.",
    "düşük orta yüksek effort",
  ),
  claude: item(
    "ai.claude",
    "ai",
    "Claude Code",
    "Opus, Sonnet ve Haiku için bu Mac'teki Claude girişi kullanılır.",
    "giriş oturum hesap abonelik login cli",
  ),
  gemini: item(
    "ai.gemini",
    "ai",
    "Gemini",
    "Gemini API anahtarı (aşağıda) ya da depodaki .env GEMINI_API_KEY; Gemini CLI otomatik algılanır.",
    "api key cli anahtar",
  ),
  geminiKey: item(
    "ai.geminiKey",
    "ai",
    "Gemini API anahtarı",
    "Bu Mac'teki kasada şifreli saklanır; worker .env yerine bunu kullanır. AI Studio'dan alınır.",
    "api key anahtar kasa denetle aistudio",
  ),
  codex: item(
    "ai.codex",
    "ai",
    "Codex (ChatGPT)",
    "OpenAI Codex CLI; ChatGPT hesabıyla giriş yapılır, sohbet Studio araçlarıyla çalışır.",
    "openai chatgpt codex cli giriş",
  ),
  openaiKey: item(
    "ai.openaiKey",
    "ai",
    "OpenAI API anahtarı",
    "GPT modelleri için (Responses API). Kasada şifreli saklanır; kullanım OpenAI hesabından ücretlendirilir.",
    "openai gpt api key anahtar chatgpt",
  ),
  antigravity: item(
    "ai.antigravity",
    "ai",
    "Antigravity",
    "Google Antigravity CLI (agy); Google hesabıyla giriş. Studio araçları bu sağlayıcıda yok.",
    "google agy antigravity cli giriş",
  ),
  // Bildirimler
  notifications: item(
    "notifications.enabled",
    "notifications",
    "macOS bildirimleri",
    "Yayınlandı / yayınlanamadı, uzun süren işler ve süresi dolmak üzere olan hesaplar.",
    "bildirim",
  ),
  // Hesaplar
  connectMeta: item(
    "accounts.connectMeta",
    "accounts",
    "Instagram ve Facebook",
    "Tarayıcıda Facebook girişi açılır.",
    "bağla hesap ekle",
  ),
  connectLinkedIn: item(
    "accounts.connectLinkedIn",
    "accounts",
    "LinkedIn",
    "Tarayıcıda LinkedIn girişi açılır.",
    "bağla hesap ekle",
  ),
  metaApp: item(
    "accounts.metaApp",
    "accounts",
    "Meta uygulaması",
    "Instagram ve Facebook için kendi Meta uygulaman.",
    "app id secret kimlik",
  ),
  linkedInApp: item(
    "accounts.linkedInApp",
    "accounts",
    "LinkedIn uygulaması",
    "LinkedIn'e yayın için kendi LinkedIn uygulaman.",
    "client id secret",
  ),
  forgetMetaSecret: item(
    "accounts.forgetMetaSecret",
    "accounts",
    "Meta App Secret'ı sil",
    "Bağlantılar bundan sonra ~1 saat geçerli olur.",
    "anahtar kaldır",
  ),
  // Yayın
  publisher: item("publishing.mode", "publishing", "Yayını yapan", "", "mac bulut"),
  lastSync: item("publishing.sync", "publishing", "Son eşitleme", "", "eşitleme hata kasa"),
  cloudPublisher: item(
    "publishing.cloud",
    "publishing",
    "Bulut yayıncı",
    "Mac kapalıyken de zamanında paylaşır. Instagram ve Facebook görselleri için gerekir.",
    "cloudflare worker PUBLISHER_TOKEN adres",
  ),
  removeCloudPublisher: item(
    "publishing.remove",
    "publishing",
    "Bulut yayıncıyı kaldır",
    "Bundan sonra yayını bu Mac yapar.",
    "sil",
  ),
  // Gelişmiş
  hostEnabled: item(
    "advanced.host",
    "advanced",
    "Studio sunucusu",
    "API ve worker'ı bu uygulama çalıştırır. Kapalıysa bu Mac'te çalışan bir Studio sunucusuna bağlanır.",
    "api worker",
  ),
  hostStatus: item("advanced.status", "advanced", "Durum", "", "yeniden başlat port"),
  lan: item("advanced.lan", "advanced", "Yerel ağdan erişim", "", "lan bonjour wifi telefon"),
  repo: item(
    "advanced.repo",
    "advanced",
    "Depo klasörü",
    "API ve worker bu klasörden çalışır (pnpm install yapılmış olmalı).",
    "repo yol",
  ),
  remote: item(
    "advanced.remote",
    "advanced",
    "Uzaktan erişim",
    "",
    "cloudflare tunnel tünel remote control ev dışı",
  ),
  tunnel: item(
    "advanced.tunnel",
    "advanced",
    "Tünel adresi ve anahtarı",
    "Anahtar (CLOUDFLARE_TUNNEL_TOKEN) bu Mac'te şifreli saklanır.",
    "cloudflare tunnel hostname token",
  ),
  errorLog: item(
    "advanced.errorLog",
    "advanced",
    "Hata kaydı",
    "API, worker ve tünelin son hata çıktıları.",
    "log",
  ),
  logsFolder: item(
    "advanced.logs",
    "advanced",
    "Kayıt klasörü",
    "API, worker ve tünel günlükleri.",
    "log günlük",
  ),
  forgetTunnel: item(
    "advanced.forgetTunnel",
    "advanced",
    "Tünel anahtarını sil",
    "Uzaktan erişim yeni anahtar girilene kadar çalışmaz.",
    "kaldır",
  ),
  backup: item(
    "advanced.backup",
    "advanced",
    "Yedekle",
    "Postları, sohbetleri, medyayı ve hesap anahtarlarını tek bir dosyaya kaydeder. Bu sırada sunucu birkaç saniye durur.",
    "yedek backup zip kaydet",
  ),
  restore: item(
    "advanced.restore",
    "advanced",
    "Yedekten geri yükle",
    "Seçtiğin yedek şu anki verilerin yerine geçer. Şu anki veriler önce ayrıca saklanır.",
    "yedek geri yükle restore",
  ),
  // Cihazlar
  pairPhone: item(
    "devices.pair",
    "devices",
    "iPhone'u bağla",
    "iPhone'daki Studio ile QR kodu okut; kod tek kullanımlık.",
    "eşleştir iphone kod qr telefon ekle",
  ),
  // Hakkında
  version: item("about.version", "about", "Sürüm", "", "versiyon"),
  dataFolder: item(
    "about.data",
    "about",
    "Veri klasörü",
    "Veritabanı, medya ve kayıtlar bu Mac'te durur.",
    "data",
  ),
  onboarding: item(
    "about.onboarding",
    "about",
    "Başlangıç rehberi",
    "Kurulum adımlarını yeniden göster.",
    "kurulum onboarding",
  ),
  shortcuts: item("about.shortcuts", "about", "Klavye kısayolları", "", "kısayol"),
} as const satisfies Record<string, SettingsItem>;

export const ALL_ITEMS: SettingsItem[] = Object.values(ITEMS);

// --- search -----------------------------------------------------------------------------------------

/** Turkish-aware, case and accent folding: "gorunum" finds "Görünüm", "zeka" finds "zekâ". */
export function normalize(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function tokens(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

/** True when every word of `query` appears in `text` (an empty query matches). */
export function matches(query: string, text: string): boolean {
  const words = tokens(query);
  if (words.length === 0) return true;
  const haystack = normalize(text);
  return words.every((w) => haystack.includes(w));
}

/** A searchable row: a fixed item or a table row (brand, account, device). */
export interface SearchRow {
  id: string;
  section: SectionId;
  text: string;
}

export function itemRow(i: SettingsItem): SearchRow {
  return { id: i.id, section: i.section, text: `${i.title} ${i.detail} ${i.keywords}` };
}

export interface SearchResult {
  section: SectionId;
  ids: string[];
}

/**
 * Rows matching `query`, grouped by section in sidebar order. A row matches by its own words
 * or its section's (title + keywords). Empty query: no results (the selected section shows).
 */
export function search(query: string, rows: SearchRow[]): SearchResult[] {
  if (tokens(query).length === 0) return [];
  const results: SearchResult[] = [];
  for (const section of SECTIONS) {
    const sectionText = `${section.title} ${section.keywords}`;
    const sectionHit = matches(query, sectionText);
    const ids = rows
      .filter((r) => r.section === section.id && (sectionHit || matches(query, r.text)))
      .map((r) => r.id);
    if (ids.length > 0) results.push({ section: section.id, ids });
  }
  return results;
}

/** Esc: a search is cleared first, then the sheet closes. */
export function escapeAction(query: string): "clear" | "close" {
  return query.length > 0 ? "clear" : "close";
}
