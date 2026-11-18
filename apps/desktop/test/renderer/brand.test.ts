import type { Brand, BrandKit, BrandProfile, SocialAccount } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  analysisBlocker,
  brandCard,
  brandInitials,
  colorName,
  familyGuess,
  kitDraft,
  kitProblem,
  newBrandInput,
  nextColorName,
  normalizedHex,
  platformLine,
  platformsSummary,
  setToken,
  tokenRows,
  voiceSummary,
} from "../../src/renderer/features/brand/brand-model.ts";
import { T } from "./fixtures.ts";

const brand: Brand = {
  id: "b1",
  name: "MTM Agro",
  slug: "mtm-agro",
  defaultLanguage: "tr",
  status: "active",
  createdAt: T,
  updatedAt: T,
};

const kit: BrandKit = {
  brandId: "b1",
  logos: [
    { assetId: "logo-dark", background: "dark" },
    { assetId: "logo-light", background: "light" },
  ],
  fonts: [
    {
      source: "file",
      assetId: "f1",
      family: "Montserrat",
      role: "display",
      styles: [],
      licenseNote: "",
    },
    {
      source: "file",
      assetId: "f2",
      family: "montserrat",
      role: "text",
      styles: [],
      licenseNote: "",
    },
    { source: "file", assetId: "f3", family: "Inter", role: "any", styles: [], licenseNote: "" },
  ],
  palette: [
    { name: "toprak", hex: "#2f5d2a" },
    { name: "filiz", hex: "7FB069" },
    { name: "bozuk", hex: "#GGG" },
  ],
  samples: [],
  notes: "",
  updatedAt: T,
};

function profile(over: Partial<BrandProfile> = {}): BrandProfile {
  return {
    id: "pr3",
    brandId: "b1",
    version: 3,
    status: "approved",
    isCurrent: true,
    tokens: {
      color: {
        accent: { value: "#e8a04a", use: "tek vurgu" },
        ink: "#151515",
        paper: { value: "#F4EFE6" },
        broken: { value: "kırmızı" },
      },
      font: {
        text: { family: "Inter", files: [] },
        display: { family: "Archivo", files: ["a", "b"], license: "OFL" },
      },
      space: { margin: 64, gutter: 24.5 },
      radius: { lg: 24, sm: 8 },
    },
    designRules: "",
    voice:
      "# Ses\n\n- Samimi ve bilgilendirici; çiftçiyle aynı dili konuşur.\n- Teknik terimleri sadeleştirir.",
    createdAt: T,
    updatedAt: T,
    approvedAt: T,
    ...over,
  };
}

function account(over: Partial<SocialAccount>): SocialAccount {
  return {
    id: "a",
    brandId: "b1",
    platform: "instagram",
    handle: "mtmagro",
    status: "connected",
    ...over,
  } as SocialAccount;
}

describe("brand card", () => {
  it("takes colours and fonts from the approved profile, logo from the kit", () => {
    const card = brandCard({
      brand,
      kit,
      profile: profile(),
      accounts: [account({}), account({ id: "x", brandId: "other", platform: "linkedin" })],
    });
    expect(card).toMatchObject({
      name: "MTM Agro",
      subtitle: "mtm-agro · Türkçe",
      initials: "MA",
      logoAssetId: "logo-light",
      profileLine: "Onaylı profil · v3",
      voice:
        "Ses Samimi ve bilgilendirici; çiftçiyle aynı dili konuşur. Teknik terimleri sadeleştirir.",
    });
    // Preferred order first (paper, ink, accent), invalid values dropped.
    expect(card.swatches).toEqual([
      { name: "paper", hex: "#F4EFE6" },
      { name: "ink", hex: "#151515" },
      { name: "accent", hex: "#E8A04A" },
    ]);
    expect(card.fonts).toEqual(["Archivo (Başlık)", "Inter (Gövde)"]);
    expect(card.platforms.map((p) => [p.platform, p.value, p.connected])).toEqual([
      ["instagram", "@mtmagro", true],
      ["facebook", "Bağlı değil", false],
      ["linkedin", "Bağlı değil", false],
    ]);
  });

  it("falls back to the kit's palette and fonts without a profile", () => {
    const card = brandCard({ brand, kit, profile: null, accounts: [] });
    expect(card.profileLine).toBe("Profil yok");
    expect(card.swatches).toEqual([
      { name: "toprak", hex: "#2F5D2A" },
      { name: "filiz", hex: "#7FB069" },
    ]);
    expect(card.fonts).toEqual(["Montserrat (Başlık)", "Inter"]);
    expect(card.voice).toBeNull();
    const draft = brandCard({
      brand,
      kit: { ...kit, logos: [{ assetId: "only-dark", background: "dark" }] },
      profile: profile({ status: "draft", isCurrent: false, version: 4, tokens: {}, voice: "" }),
      accounts: [],
    });
    expect(draft.profileLine).toBe("Taslak profil · v4");
    expect(draft.logoAssetId).toBe("only-dark");
    expect(draft.voice).toBeNull();
  });

  it("summarises platforms and what needs the owner", () => {
    expect(platformLine("instagram", [account({ handle: "" })]).value).toBe("Bağlı");
    expect(
      platformLine("linkedin", [account({ platform: "linkedin", handle: "MTM Agro" })]).value,
    ).toBe("MTM Agro");
    expect(platformLine("instagram", [account({ status: "needs_reauth" })])).toMatchObject({
      value: "Yeniden bağla",
      needsOwner: true,
    });
    expect(platformLine("instagram", [account({ tokenHealth: "expiring_soon" })])).toMatchObject({
      value: "Kontrol et",
      connected: true,
      needsOwner: true,
    });
    expect(platformLine("instagram", [account({ status: "disabled" })]).value).toBe("Bağlı değil");
    const lines = brandCard({
      brand,
      kit: null,
      profile: null,
      accounts: [
        account({}),
        account({ id: "f", platform: "facebook", handle: "MTM" }),
        account({ id: "l", platform: "linkedin", handle: "mtm" }),
      ],
    }).platforms;
    expect(platformsSummary(lines)).toEqual({ text: "3 hesap bağlı", attention: false });
    expect(platformsSummary([])).toEqual({ text: "Hesap bağlı değil", attention: false });
    expect(
      platformsSummary([platformLine("instagram", [account({ status: "needs_reauth" })])]),
    ).toEqual({
      text: "Instagram yeniden bağlanmalı",
      attention: true,
    });
  });

  it("makes initials and voice summaries like the Mac", () => {
    expect(brandInitials("MTM Agro")).toBe("MA");
    expect(brandInitials("finvo")).toBe("F");
    expect(brandInitials("ıhlamur çay evi")).toBe("IÇ");
    expect(brandInitials("  ")).toBe("?");
    const long = `${"Kısa cümle. ".repeat(10)}Çok uzun bir kuyruk ${"x".repeat(200)}`;
    const summary = voiceSummary(long) ?? "";
    expect(summary.endsWith(".")).toBe(true);
    expect([...summary].length).toBeLessThanOrEqual(220);
    expect(voiceSummary("x".repeat(300))).toBe(`${"x".repeat(220)}…`);
    expect(voiceSummary("## \n- ")).toBeNull();
  });
});

describe("profile tokens and kit rules", () => {
  it("lists editable rows in a stable order and edits them", () => {
    const rows = tokenRows(profile().tokens);
    expect(rows.map((r) => `${r.group}:${r.label}=${r.value}`)).toEqual([
      "Renkler:paper=#F4EFE6",
      "Renkler:ink=#151515",
      "Renkler:accent=#e8a04a",
      "Renkler:broken=kırmızı",
      "Yazı tipleri:Başlık ailesi=Archivo",
      "Yazı tipleri:Başlık lisansı=OFL",
      "Yazı tipleri:Gövde ailesi=Inter",
      "Boşluk:Kenar boşluğu=64",
      "Boşluk:Aralık=24.5",
      "Köşeler:sm=8",
      "Köşeler:lg=24",
    ]);
    const accent = rows.find((r) => r.label === "accent");
    if (!accent) throw new Error("no accent row");
    expect(accent.note).toBe("tek vurgu");
    const set = setToken(profile().tokens, accent, "ff6a00");
    expect(set.ok && (set.tokens.color as Record<string, { value: string }>).accent).toEqual({
      value: "#FF6A00",
      use: "tek vurgu",
    });
    expect(setToken(profile().tokens, accent, "turuncu")).toEqual({
      ok: false,
      reason: "Renk #RRGGBB biçiminde olmalı.",
    });
    const family = rows.find((r) => r.label === "Gövde ailesi");
    if (!family) throw new Error("no family row");
    expect(setToken({}, family, "Inter_Display")).toEqual({
      ok: false,
      reason: "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir.",
    });
    const margin = rows.find((r) => r.label === "Kenar boşluğu");
    if (!margin) throw new Error("no margin row");
    const spaced = setToken(profile().tokens, margin, "48,5");
    expect(spaced.ok && (spaced.tokens.space as Record<string, number>).margin).toBe(48.5);
    expect(setToken(profile().tokens, margin, "3000").ok).toBe(false);
  });

  it("normalises colours, names and font families", () => {
    expect(normalizedHex("#ff6a00")).toBe("#FF6A00");
    expect(normalizedHex("f60")).toBe("#FF6600");
    expect(normalizedHex("#12345")).toBeNull();
    expect(colorName("Ana Vurgu")).toBe("ana-vurgu");
    expect(colorName("Çok Şık Yeşil")).toBe("cok-sik-yesil");
    expect(colorName("1. renk")).toBeNull();
    expect(familyGuess("Archivo-BoldItalic.woff2")).toBe("Archivo");
    expect(familyGuess("InterDisplay_Regular.ttf")).toBe("Inter Display");
    expect(familyGuess("___.otf")).toBe("Marka Fontu");
  });

  it("checks the kit before saving", () => {
    expect(kitProblem(kitDraft({ ...kit, palette: [{ name: "a", hex: "#000000" }] }))).toBeNull();
    expect(kitProblem(kitDraft(kit))).toBe("“filiz” rengi #RRGGBB biçiminde olmalı.");
    expect(
      kitProblem(
        kitDraft({
          ...kit,
          palette: [
            { name: "a", hex: "#000000" },
            { name: "a", hex: "#FFFFFF" },
          ],
        }),
      ),
    ).toBe("“a” adı iki renkte kullanılmış.");
    expect(kitProblem(kitDraft({ ...kit, palette: [{ name: "Ana", hex: "#000000" }] }))).toContain(
      "küçük harf",
    );
    expect(nextColorName(kitDraft({ ...kit, palette: [{ name: "renk-1", hex: "#000000" }] }))).toBe(
      "renk-2",
    );
  });

  it("says why AI analysis cannot start", () => {
    const samples = [{ assetId: "1" }, { assetId: "2" }, { assetId: "3" }];
    expect(analysisBlocker({ brand, kit: { samples }, workerOnline: true })).toBeNull();
    expect(analysisBlocker({ brand, kit: { samples: [] }, workerOnline: true })).toContain(
      "en az 3 örnek",
    );
    expect(analysisBlocker({ brand, kit: { samples }, workerOnline: false })).toContain(
      "Arka plan çalışmıyor",
    );
    expect(
      analysisBlocker({ brand: { status: "archived" }, kit: { samples }, workerOnline: true }),
    ).toBe("Arşivlenmiş markada profil çıkarılamaz.");
  });

  it("validates a new brand", () => {
    expect(newBrandInput(" MTM Agro ", "", "tr")).toEqual({
      ok: true,
      input: { name: "MTM Agro", slug: "mtm-agro", defaultLanguage: "tr" },
    });
    expect(newBrandInput("", "", "tr")).toEqual({ ok: false, reason: "Marka adı boş olamaz." });
    expect(newBrandInput("X", "kötü slug", "tr").ok).toBe(false);
  });
});
