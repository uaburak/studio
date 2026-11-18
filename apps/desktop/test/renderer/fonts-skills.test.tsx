import type { ApiClient, Brand, BrandSkill, BrandSkillVersion } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontPicker, fontPickerRows } from "../../src/renderer/components/ui/font-picker.tsx";
import {
  addSystemFont,
  fallbackFileOf,
  isFallbackFile,
  type KitFont,
  kitStylesLabel,
  toggleSystemFontStyle,
} from "../../src/renderer/features/brand/brand-model.ts";
import { skillKeys } from "../../src/renderer/features/brand/skills-data.ts";
import {
  formChanged,
  formOf,
  newSkillForm,
  skillDraftBlocker,
  skillFormProblem,
  skillMeta,
} from "../../src/renderer/features/brand/skills-model.ts";
import { SkillsSection } from "../../src/renderer/features/brand/skills-section.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import {
  familiesFromLocalFonts,
  type InstalledFonts,
  recentFonts,
  rememberFont,
  SAMPLE_FONTS,
} from "../../src/renderer/lib/fonts.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";

vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, useJobs: () => ({ jobs: [], presence: null, controller: {} }) };
});

const T = "2026-11-17T10:00:00.000Z";
const FONTS: InstalledFonts = { families: SAMPLE_FONTS, scannedAt: T, source: "appkit" };

function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  useAppStore.setState({ toasts: [] });
  localStorage.clear();
});

describe("FontPicker", () => {
  it("lists brand fonts, recent ones and every family once, filtered by the search", () => {
    const rows = fontPickerRows({
      families: SAMPLE_FONTS,
      pinned: ["Avenir Next", "Söhne"],
      recent: ["Georgia", "Avenir Next", "Gone Font"],
      query: "",
      pinnedLabel: "Marka fontları",
    });
    const shape = rows.map((r) => (r.kind === "label" ? `# ${r.text}` : r.family));
    expect(shape).toEqual([
      "# Marka fontları",
      "Avenir Next",
      "Söhne",
      "# Son kullanılanlar",
      "Georgia",
      `# Tüm yazı tipleri · ${SAMPLE_FONTS.length}`,
      ...SAMPLE_FONTS.map((f) => f.family).filter((f) => f !== "Avenir Next" && f !== "Georgia"),
    ]);
    // A pinned family that is not installed has no data.
    expect(rows.find((r) => r.kind === "family" && r.family === "Söhne")).toMatchObject({
      data: null,
    });
    const search = fontPickerRows({
      families: SAMPLE_FONTS,
      pinned: [],
      recent: [],
      query: "helvetıca",
      pinnedLabel: "x",
    });
    expect(
      search.filter((r) => r.kind === "family").map((r) => r.kind === "family" && r.family),
    ).toEqual(["Helvetica Neue"]);
    expect(
      fontPickerRows({
        families: SAMPLE_FONTS,
        pinned: [],
        recent: [],
        query: "newyork",
        pinnedLabel: "x",
      }).filter((r) => r.kind === "family").length,
    ).toBe(1);
  });

  it("picks a family, or a style from its flyout with the keyboard, and remembers it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    providers(
      <FontPicker
        label="Yazı tipi"
        value={null}
        fonts={FONTS}
        pinned={["Futura"]}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Yazı tipi" }));
    const dialog = screen.getByRole("dialog", { name: "Yazı tipi" });
    expect(within(dialog).getByText("Marka fontları")).toBeInTheDocument();
    // Each family is shown in its own face.
    const futura = within(dialog)
      .getAllByRole("option")
      .find((o) => o.textContent?.startsWith("Futura"));
    expect(futura?.querySelector("span")?.getAttribute("style")).toContain("Futura");

    await user.type(within(dialog).getByRole("searchbox", { name: "Yazı tipi ara" }), "avenir");
    await user.keyboard("{ArrowRight}");
    const styles = await screen.findByRole("listbox", { name: "Avenir Next stilleri" });
    expect(
      within(styles)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toContain("Demi Bold600");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith({
      family: "Avenir Next",
      style: expect.objectContaining({ name: "Medium", weight: 500 }),
    });
    expect(recentFonts()[0]).toBe("Avenir Next");
    expect(screen.queryByRole("dialog", { name: "Yazı tipi" })).not.toBeInTheDocument();

    // Clicking a family row picks the family as a whole.
    await user.click(screen.getByRole("button", { name: "Yazı tipi" }));
    const georgia = screen.getAllByRole("option").find((o) => o.textContent?.startsWith("Georgia"));
    await user.click(georgia as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({ family: "Georgia", style: null });
  });

  it("explains the stand-in list and reads the browser's local fonts", () => {
    expect(rememberFont("Futura")).toEqual(["Futura"]);
    const families = familiesFromLocalFonts([
      { family: "Inter", style: "Bold Italic", postscriptName: "Inter-BoldItalic" },
      { family: "Inter", style: "Regular", postscriptName: "Inter-Regular" },
      { family: ".Hidden", style: "Regular", postscriptName: "x" },
    ]);
    expect(families).toEqual([
      {
        family: "Inter",
        styles: [
          { name: "Regular", postscriptName: "Inter-Regular", weight: 400, italic: false },
          { name: "Bold Italic", postscriptName: "Inter-BoldItalic", weight: 700, italic: true },
        ],
      },
    ]);
  });
});

describe("kit fonts", () => {
  const file: KitFont = {
    source: "file",
    assetId: "f1",
    family: "Avenir Next",
    role: "display",
    styles: [],
    licenseNote: "",
  };

  it("adds installed fonts, their styles, and treats a same-family file as the fallback", () => {
    const demi = {
      name: "Demi Bold",
      weight: 600,
      italic: false,
      postscriptName: "AvenirNext-DemiBold",
    };
    let fonts = addSystemFont([file], { family: "Avenir Next", style: demi });
    expect(fonts[1]).toEqual({
      source: "system",
      family: "Avenir Next",
      role: "any",
      styles: [
        { name: "Demi Bold", weight: 600, italic: false, postscriptName: "AvenirNext-DemiBold" },
      ],
      licenseNote: "",
    });
    fonts = addSystemFont(fonts, {
      family: "avenir next",
      style: { name: "Regular", weight: 400, italic: false },
    });
    expect(fonts).toHaveLength(2);
    expect(fonts[1]?.styles.map((s) => s.name)).toEqual(["Regular", "Demi Bold"]);
    expect(kitStylesLabel(fonts[1] as KitFont)).toBe("Regular · Demi Bold");
    const toggled = toggleSystemFontStyle(fonts[1] as KitFont, demi);
    expect(toggled.styles.map((s) => s.name)).toEqual(["Regular"]);
    expect(kitStylesLabel({ ...toggled, styles: [] })).toBe("Tüm stiller");
    expect(isFallbackFile(fonts, file)).toBe(true);
    expect(fallbackFileOf(fonts, fonts[1] as KitFont)).toBe(file);
    expect(isFallbackFile([file], file)).toBe(false);
  });
});

const skill = (over: Partial<BrandSkill> = {}): BrandSkill => ({
  id: "s1",
  brandId: "b1",
  name: "mtm",
  description: "Tek görsel post formatı",
  body: "# MTM\n\n- 1080×1350",
  enabled: true,
  version: 3,
  origin: "manual",
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe("skills model", () => {
  it("checks the form, names new skills and labels them", () => {
    const others = [skill(), skill({ id: "s2", name: "yeni-skill" })];
    expect(newSkillForm(others).name).toBe("yeni-skill-2");
    expect(skillFormProblem({ ...formOf(null), name: "mtm" }, others)).toContain("zaten var");
    expect(skillFormProblem({ ...formOf(null), name: "Büyük" }, [])).toContain("küçük harf");
    expect(skillFormProblem({ ...formOf(null), name: "ok", body: "  " }, [])).toContain("boş");
    expect(skillFormProblem({ ...formOf(null), name: "ok" }, [])).toBeNull();
    expect(formChanged(formOf(skill()), skill())).toBe(false);
    expect(formChanged({ ...formOf(skill()), note: "x" }, skill())).toBe(false);
    expect(formChanged({ ...formOf(skill()), body: "y" }, skill())).toBe(true);
    expect(skillMeta(skill({ origin: "ai_draft", enabled: false, version: 1 }))).toBe(
      "v1 · AI taslağı · kapalı",
    );
    expect(skillDraftBlocker({ archived: false, workerOnline: false, count: 0 })).toContain(
      "Arka plan",
    );
    expect(skillDraftBlocker({ archived: false, workerOnline: true, count: 30 })).toContain("30");
    expect(skillDraftBlocker({ archived: false, workerOnline: true, count: 2 })).toBeNull();
  });
});

describe("Skill'ler section", () => {
  const brand: Brand = {
    id: "b1",
    name: "MTM Agro",
    slug: "mtm-agro",
    defaultLanguage: "tr",
    status: "active",
    createdAt: T,
    updatedAt: T,
  };
  const versions: BrandSkillVersion[] = [3, 2, 1].map((v) => ({
    id: `v${v}`,
    skillId: "s1",
    brandId: "b1",
    version: v,
    name: "mtm",
    description: "Tek görsel post formatı",
    body: `# MTM v${v}`,
    origin: v === 1 ? "ai_draft" : "manual",
    note: v === 2 ? "logo kuralı" : "",
    jobId: null,
    createdAt: T,
  }));

  it("lists skills, switches one on, edits, restores a version and explains AI drafts offline", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async (_b: string, id: string, input: Record<string, unknown>) =>
      id === "s2"
        ? skill({ id: "s2", name: "partner", enabled: true, version: 1, origin: "ai_draft" })
        : skill({ ...input, version: 4 }),
    );
    const restore = vi.fn(async () => skill({ body: "# MTM v2", version: 5, origin: "restore" }));
    providers(
      <SkillsSection brand={brand} />,
      { brandSkills: { update, restore, versions: { restore } } },
      (q) => {
        q.setQueryData(skillKeys.list("b1"), [
          skill(),
          skill({ id: "s2", name: "partner", enabled: false, version: 1, origin: "ai_draft" }),
        ]);
        q.setQueryData(skillKeys.versions("b1", "s1"), versions);
      },
    );
    const list = screen.getByRole("list", { name: "Skill listesi" });
    expect(within(list).getByText("v1 · AI taslağı · kapalı")).toBeInTheDocument();
    // The first skill is open in the editor.
    expect(screen.getByRole("textbox", { name: "Skill adı" })).toHaveValue("mtm");

    await user.click(within(list).getByRole("switch", { name: "partner kapalı" }));
    expect(update).toHaveBeenCalledWith("b1", "s2", { enabled: true });

    const body = screen.getByRole("textbox", { name: "Skill metni (Markdown)" });
    await user.type(body, "\n- Logo sağ altta.");
    await user.type(screen.getByRole("textbox", { name: "Değişiklik notu" }), "logo");
    await user.click(screen.getByRole("radio", { name: /Önizleme/ }));
    expect(screen.getByText("Logo sağ altta.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("b1", "s1", {
        name: "mtm",
        description: "Tek görsel post formatı",
        body: "# MTM\n\n- 1080×1350\n- Logo sağ altta.",
        note: "logo",
      }),
    );

    await user.click(screen.getByRole("radio", { name: /Geçmiş/ }));
    expect(screen.getByText(/logo kuralı/)).toBeInTheDocument();
    // Saved as v4 (versions are not refetched here): every listed version can come back.
    const restoreButtons = screen.getAllByRole("button", { name: "Geri yükle" });
    expect(restoreButtons).toHaveLength(3);
    await user.click(restoreButtons[0] as HTMLElement);
    expect(restore).toHaveBeenCalledWith("b1", "s1", 3);

    await user.click(screen.getByRole("button", { name: "AI ile çıkar" }));
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("Arka plan çalışmıyor");
  });
});
