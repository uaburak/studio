// The brand card and the brand profile editor as plain values (tested without views). Port of
// StudioMac's BrandCardContent (Inspector/PanelPaneContent.swift), ProfileTokens
// (Brands/BrandProfileEditing.swift) and StudioKit's BrandKitRules: the approved profile's
// tokens win over the raw kit for colours and fonts.
import {
  type Brand,
  type BrandKit,
  type BrandKitFontRole,
  type BrandProfile,
  brandKitAnalysisBlocker,
  type Platform,
  type SocialAccount,
  slugify,
} from "@studio/contract";

// --- kit rules ------------------------------------------------------------------------------------

/** `#RRGGBB` (also `RRGGBB` and `#RGB`) → `#RRGGBB` upper case, or null. */
export function normalizedHex(raw: string): string | null {
  let clean = raw.trim().toUpperCase();
  if (clean.startsWith("#")) clean = clean.slice(1);
  if (clean.length === 3) clean = [...clean].map((c) => c + c).join("");
  return /^[0-9A-F]{6}$/.test(clean) ? `#${clean}` : null;
}

/** `Ana Vurgu` → `ana-vurgu`; null when nothing usable remains (must start with a letter). */
export function colorName(raw: string): string | null {
  const slug = slugify(raw).slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : null;
}

/** Family names the contract accepts: letters, digits, spaces, dashes. */
export function isValidFamily(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && t.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(t);
}

/** `Archivo-BoldItalic.woff2` → `Archivo`, `InterDisplay.ttf` → `Inter Display`. */
export function familyGuess(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const head = base.split(/[-_]/)[0] ?? base;
  const spaced = head.replace(/([a-z])([A-Z])/g, "$1 $2");
  const cleaned = spaced.replace(/[^A-Za-z0-9 ]/g, "").trim();
  return isValidFamily(cleaned) ? cleaned : "Marka Fontu";
}

/** File names that suggest a logo for dark backgrounds. */
export function looksLikeNegativeLogo(filename: string): boolean {
  return /(negatif|negative|beyaz|white|dark|koyu|inverse|ters)/i.test(filename);
}

export const FONT_ROLE_LABEL: Record<BrandKitFontRole, string> = {
  display: "Başlık",
  text: "Gövde",
  any: "Her ikisi",
};

export const LANGUAGES: { tag: string; label: string }[] = [
  { tag: "tr", label: "Türkçe" },
  { tag: "en", label: "İngilizce" },
  { tag: "de", label: "Almanca" },
  { tag: "fr", label: "Fransızca" },
  { tag: "es", label: "İspanyolca" },
  { tag: "it", label: "İtalyanca" },
  { tag: "ar", label: "Arapça" },
  { tag: "ru", label: "Rusça" },
];

export function languageLabel(tag: string): string {
  return LANGUAGES.find((l) => l.tag === tag)?.label ?? tag;
}

// --- profile tokens --------------------------------------------------------------------------------

export type TokenKind = "color" | "text" | "number";
export type TokenGroup = "Renkler" | "Yazı tipleri" | "Boşluk" | "Köşeler";

export interface TokenRow {
  path: string[];
  label: string;
  group: TokenGroup;
  kind: TokenKind;
  value: string;
  note: string | null;
}

const GROUP_ORDER: TokenGroup[] = ["Renkler", "Yazı tipleri", "Boşluk", "Köşeler"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function orderedKeys(keys: string[], preferred: string[]): string[] {
  return [
    ...preferred.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !preferred.includes(k)).sort(),
  ];
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** The editable scalars of `brand.json` tokens, in a stable order: colours, fonts, spacing, radii. */
export function tokenRows(tokens: Json): TokenRow[] {
  const rows: TokenRow[] = [];
  const colors = tokens.color;
  if (isObject(colors)) {
    const order = ["paper", "mist", "ink", "graphite", "stone", "line", "accent", "accent-deep"];
    for (const name of orderedKeys(Object.keys(colors), order)) {
      const entry = colors[name];
      if (typeof entry === "string") {
        rows.push({
          path: ["color", name],
          label: name,
          group: "Renkler",
          kind: "color",
          value: entry,
          note: null,
        });
      } else if (isObject(entry) && typeof entry.value === "string") {
        rows.push({
          path: ["color", name, "value"],
          label: name,
          group: "Renkler",
          kind: "color",
          value: entry.value,
          note: typeof entry.use === "string" ? entry.use : null,
        });
      }
    }
  }
  const fonts = tokens.font;
  if (isObject(fonts)) {
    for (const role of orderedKeys(Object.keys(fonts), ["display", "text"])) {
      const entry = fonts[role];
      if (!isObject(entry)) continue;
      const roleLabel = role === "display" ? "Başlık" : role === "text" ? "Gövde" : role;
      if (typeof entry.family === "string") {
        const files = Array.isArray(entry.files) ? entry.files.length : 0;
        rows.push({
          path: ["font", role, "family"],
          label: `${roleLabel} ailesi`,
          group: "Yazı tipleri",
          kind: "text",
          value: entry.family,
          note: files > 0 ? `${files} dosya` : "Dosya yok, sistem fontu",
        });
      }
      if (typeof entry.license === "string") {
        rows.push({
          path: ["font", role, "license"],
          label: `${roleLabel} lisansı`,
          group: "Yazı tipleri",
          kind: "text",
          value: entry.license,
          note: null,
        });
      }
    }
  }
  const space = tokens.space;
  if (isObject(space)) {
    const labels: Record<string, string> = {
      margin: "Kenar boşluğu",
      gutter: "Aralık",
      unit: "Birim",
      columns: "Sütun",
    };
    for (const key of ["margin", "gutter", "unit", "columns"]) {
      const value = space[key];
      if (typeof value === "number") {
        rows.push({
          path: ["space", key],
          label: labels[key] ?? key,
          group: "Boşluk",
          kind: "number",
          value: formatNumber(value),
          note: key === "columns" ? null : "px",
        });
      }
    }
  }
  const radius = tokens.radius;
  if (isObject(radius)) {
    for (const key of orderedKeys(Object.keys(radius), ["sm", "md", "lg", "pill"])) {
      const value = radius[key];
      if (typeof value === "number") {
        rows.push({
          path: ["radius", key],
          label: key,
          group: "Köşeler",
          kind: "number",
          value: formatNumber(value),
          note: "px",
        });
      }
    }
  }
  return rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** null when `value` is acceptable for the kind, else a Turkish reason. */
export function tokenProblem(kind: TokenKind, value: string): string | null {
  const t = value.trim();
  switch (kind) {
    case "color":
      return normalizedHex(t) ? null : "Renk #RRGGBB biçiminde olmalı.";
    case "number": {
      const n = Number(t.replace(",", "."));
      return t !== "" && Number.isFinite(n) && n >= 0 && n <= 2000
        ? null
        : "0 ile 2000 arasında bir sayı girin.";
    }
    case "text":
      return t ? null : "Boş bırakılamaz.";
  }
}

function setPath(object: Json, path: string[], value: unknown): Json {
  const [head, ...rest] = path;
  if (head === undefined) return object;
  if (rest.length === 0) return { ...object, [head]: value };
  const child = isObject(object[head]) ? (object[head] as Json) : {};
  return { ...object, [head]: setPath(child, rest, value) };
}

/** Tokens with `row.path` set to `value` (normalised), or the Turkish reason it is refused. */
export function setToken(
  tokens: Json,
  row: Pick<TokenRow, "path" | "kind">,
  value: string,
): { ok: true; tokens: Json } | { ok: false; reason: string } {
  const problem = tokenProblem(row.kind, value);
  if (problem) return { ok: false, reason: problem };
  const t = value.trim();
  if (row.path[0] === "font" && row.path.at(-1) === "family" && !isValidFamily(t)) {
    return { ok: false, reason: "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir." };
  }
  const json =
    row.kind === "color"
      ? normalizedHex(t)
      : row.kind === "number"
        ? Number(t.replace(",", "."))
        : t;
  return { ok: true, tokens: setPath(tokens, row.path, json) };
}

// --- brand card ------------------------------------------------------------------------------------

export interface Swatch {
  name: string;
  /** `#RRGGBB`. */
  hex: string;
}

export interface PlatformLine {
  platform: Platform;
  /** "@mtmagro", "Bağlı değil", "Yeniden bağla". */
  value: string;
  connected: boolean;
  needsOwner: boolean;
}

export interface BrandCard {
  name: string;
  /** "mtm-agro · Türkçe". */
  subtitle: string;
  initials: string;
  logoAssetId: string | null;
  /** "Onaylı profil · v3", "Taslak profil · v1", "Profil yok". */
  profileLine: string;
  swatches: Swatch[];
  /** "Archivo (Başlık)", "Inter (Gövde)". */
  fonts: string[];
  /** The voice text's opening (null: no voice written yet). */
  voice: string | null;
  platforms: PlatformLine[];
}

export const MAX_SWATCHES = 8;
export const VOICE_LIMIT = 220;
export const PLATFORMS: Platform[] = ["instagram", "facebook", "linkedin"];
export const PLATFORM_NAME: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/** "MTM Agro" → "MA", "Finvo" → "F". */
export function brandInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => [...w][0] ?? "")
    .map((c) => c.toLocaleUpperCase("tr-TR"));
  return letters.join("") || "?";
}

/** The voice text's opening (markdown headings and bullets dropped), at most VOICE_LIMIT chars. */
export function voiceSummary(voice: string): string | null {
  const lines = voice
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[#\-*>\s]+/, "")
        .trim(),
    )
    .filter(Boolean);
  const joined = lines.join(" ");
  if (!joined) return null;
  if ([...joined].length <= VOICE_LIMIT) return joined;
  const cut = [...joined].slice(0, VOICE_LIMIT).join("");
  const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  if (end > VOICE_LIMIT / 2) return cut.slice(0, end + 1);
  return `${cut.trim()}…`;
}

export function profileLine(profile: BrandProfile | null | undefined): string {
  if (!profile) return "Profil yok";
  return profile.status === "approved"
    ? `Onaylı profil · v${profile.version}`
    : `Taslak profil · v${profile.version}`;
}

const TOKEN_TROUBLE = new Set(["expiring_soon", "invalid", "missing_scopes"]);

export function platformLine(platform: Platform, accounts: readonly SocialAccount[]): PlatformLine {
  const candidates = accounts.filter((a) => a.platform === platform && a.status !== "disabled");
  const account = candidates.find((a) => a.status === "connected") ?? candidates[0];
  if (!account) return { platform, value: "Bağlı değil", connected: false, needsOwner: false };
  const handle = account.handle.trim();
  const shown = !handle
    ? "Bağlı"
    : platform === "instagram" && !handle.startsWith("@")
      ? `@${handle}`
      : handle;
  switch (account.status) {
    case "connected": {
      const needs = account.tokenHealth !== undefined && TOKEN_TROUBLE.has(account.tokenHealth);
      return { platform, value: needs ? "Kontrol et" : shown, connected: true, needsOwner: needs };
    }
    case "needs_reauth":
      return { platform, value: "Yeniden bağla", connected: false, needsOwner: true };
    default:
      return { platform, value: "Bekliyor", connected: false, needsOwner: false };
  }
}

/** "3 hesap bağlı", "Hesap bağlı değil", "Instagram yeniden bağlanmalı". */
export function platformsSummary(lines: readonly PlatformLine[]): {
  text: string;
  attention: boolean;
} {
  const trouble = lines.filter((l) => l.needsOwner);
  if (trouble.length > 0) {
    const names = trouble.map((l) => PLATFORM_NAME[l.platform]).join(", ");
    return { text: `${names} yeniden bağlanmalı`, attention: true };
  }
  const connected = lines.filter((l) => l.connected).length;
  return {
    text: connected === 0 ? "Hesap bağlı değil" : `${connected} hesap bağlı`,
    attention: false,
  };
}

export function brandCard(input: {
  brand: Brand;
  kit: BrandKit | null | undefined;
  profile: BrandProfile | null | undefined;
  accounts: readonly SocialAccount[];
}): BrandCard {
  const { brand, kit, profile } = input;
  const rows = profile ? tokenRows(profile.tokens) : [];
  let swatches: Swatch[] = rows
    .filter((r) => r.kind === "color" && r.group === "Renkler")
    .flatMap((r) => {
      const hex = normalizedHex(r.value);
      return hex ? [{ name: r.label, hex }] : [];
    });
  if (swatches.length === 0) {
    swatches = (kit?.palette ?? []).flatMap((c) => {
      const hex = normalizedHex(c.hex);
      return hex ? [{ name: c.name, hex }] : [];
    });
  }
  let fonts = rows
    .filter((r) => r.path.at(-1) === "family")
    .map((r) => `${r.value} (${r.label.replace(" ailesi", "")})`);
  if (fonts.length === 0) {
    const seen = new Set<string>();
    fonts = (kit?.fonts ?? []).flatMap((f) => {
      const family = f.family.trim();
      if (!family || seen.has(family.toLowerCase())) return [];
      seen.add(family.toLowerCase());
      return [f.role === "any" ? family : `${family} (${FONT_ROLE_LABEL[f.role]})`];
    });
  }
  const logo = kit?.logos.find((l) => l.background !== "dark") ?? kit?.logos[0];
  const accounts = input.accounts.filter((a) => a.brandId === brand.id);
  return {
    name: brand.name,
    subtitle: `${brand.slug} · ${languageLabel(brand.defaultLanguage)}`,
    initials: brandInitials(brand.name),
    logoAssetId: logo?.assetId ?? null,
    profileLine: profileLine(profile),
    swatches: swatches.slice(0, MAX_SWATCHES),
    fonts,
    voice: profile ? voiceSummary(profile.voice) : null,
    platforms: PLATFORMS.map((p) => platformLine(p, accounts)),
  };
}

// --- kit editing -----------------------------------------------------------------------------------------

export type KitDraft = Pick<BrandKit, "logos" | "fonts" | "palette" | "samples" | "notes">;

export function kitDraft(kit: BrandKit | null | undefined): KitDraft {
  return {
    logos: kit?.logos ?? [],
    fonts: kit?.fonts ?? [],
    palette: kit?.palette ?? [],
    samples: kit?.samples ?? [],
    notes: kit?.notes ?? "",
  };
}

/** The first reason the kit cannot be saved as it is (Turkish), or null. */
export function kitProblem(kit: KitDraft): string | null {
  const names = new Set<string>();
  for (const color of kit.palette) {
    if (!/^[a-z][a-z0-9-]*$/.test(color.name) || color.name.length > 48) {
      return `“${color.name || "adsız"}” renk adı küçük harf, rakam ve tire içermeli.`;
    }
    if (names.has(color.name)) return `“${color.name}” adı iki renkte kullanılmış.`;
    names.add(color.name);
    if (!/^#[0-9A-Fa-f]{6}$/.test(color.hex))
      return `“${color.name}” rengi #RRGGBB biçiminde olmalı.`;
  }
  for (const font of kit.fonts) {
    if (!isValidFamily(font.family)) {
      return "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir.";
    }
  }
  if (kit.samples.length > 12) return "En fazla 12 örnek post görseli kullanılabilir.";
  return null;
}

/** The next free colour name ("renk-1", "renk-2", …). */
export function nextColorName(kit: KitDraft): string {
  const used = new Set(kit.palette.map((c) => c.name));
  for (let i = 1; ; i++) if (!used.has(`renk-${i}`)) return `renk-${i}`;
}

// --- analysis ------------------------------------------------------------------------------------------

/** Why "AI ile analiz et" cannot start, or null. */
export function analysisBlocker(input: {
  brand: Pick<Brand, "status">;
  kit: Pick<BrandKit, "samples"> | null | undefined;
  workerOnline: boolean;
}): string | null {
  if (input.brand.status === "archived") return "Arşivlenmiş markada profil çıkarılamaz.";
  const blocker = brandKitAnalysisBlocker(input.kit ?? { samples: [] });
  if (blocker) return blocker;
  if (!input.workerOnline) {
    return "Arka plan çalışmıyor; Studio hazır olunca profil çıkarılabilir.";
  }
  return null;
}

/** New brand form → `BrandCreate`, or a Turkish reason. */
export function newBrandInput(
  name: string,
  slug: string,
  language: string,
):
  | { ok: true; input: { name: string; slug: string; defaultLanguage: string } }
  | { ok: false; reason: string } {
  const n = name.trim();
  if (!n) return { ok: false, reason: "Marka adı boş olamaz." };
  if (n.length > 120) return { ok: false, reason: "Marka adı en fazla 120 karakter olabilir." };
  const s = (slug.trim() || slugify(n)).toLowerCase();
  if (s.length < 2 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    return { ok: false, reason: "Kısa ad yalnızca küçük harf, rakam ve tek tire içerebilir." };
  }
  return { ok: true, input: { name: n, slug: s, defaultLanguage: language || "tr" } };
}
