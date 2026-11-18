import {
  type ApiClient,
  type Brand,
  type BrandProduct,
  emptyBrandKit,
  type SocialAccount,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brandKeys } from "../../src/renderer/features/brand/brand-data.ts";
import BrandPage, { BRAND_TAB_OPTIONS } from "../../src/renderer/features/brand/brand-page.tsx";
import BrandsPage, { brandsShown } from "../../src/renderer/features/brand/brands-page.tsx";
import { productKeys } from "../../src/renderer/features/brand/products-data.ts";
import {
  addTags,
  makeCover,
  productDraft,
  productMatches,
  productPatch,
  productProblem,
} from "../../src/renderer/features/brand/products-model.ts";
import { ProductsTab } from "../../src/renderer/features/brand/products-tab.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { queryKeys } from "../../src/renderer/state/studio.tsx";

// The live job feed (StudioProvider) is not mounted here: no jobs, worker offline.
vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, useJobs: () => ({ jobs: [], presence: null, controller: {} }) };
});

const T = "2026-11-17T10:00:00.000Z";

const brand = (id: string, name: string, over: Partial<Brand> = {}): Brand => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  defaultLanguage: "tr",
  status: "active",
  createdAt: T,
  updatedAt: T,
  ...over,
});

const BRANDS = [
  brand("b1", "MTM Agro"),
  brand("b2", "Çiftçi Dostu", { defaultLanguage: "en" }),
  brand("b3", "Eski Marka", { status: "archived" }),
];

const ACCOUNTS = [
  {
    id: "s1",
    brandId: "b1",
    platform: "instagram",
    handle: "mtmagro",
    status: "connected",
  },
] as SocialAccount[];

const product = (id: string, over: Partial<BrandProduct> = {}): BrandProduct => ({
  id,
  brandId: "b1",
  name: `Ürün ${id}`,
  description: "",
  category: "",
  tags: [],
  notes: "",
  imageAssetIds: [],
  createdAt: T,
  updatedAt: T,
  ...over,
});

function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

const seedBrands = (q: QueryClient) => {
  q.setQueryData(queryKeys.brands, BRANDS);
  q.setQueryData(queryKeys.accounts, ACCOUNTS);
};

beforeEach(() => {
  useAppStore.setState({
    route: { kind: "brands" },
    post: null,
    back: [],
    forward: [],
    currentBrandId: "b1",
  });
});

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

describe("Markalar list", () => {
  it("filters by status, searches both tabs and sorts by name", () => {
    expect(brandsShown(BRANDS, "active", "").map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(brandsShown(BRANDS, "archived", "").map((b) => b.id)).toEqual(["b3"]);
    expect(brandsShown(BRANDS, "active", "eski").map((b) => b.id)).toEqual(["b3"]);
    expect(brandsShown(BRANDS, "active", "ÇİFT").map((b) => b.id)).toEqual(["b2"]);
    expect(brandsShown(BRANDS, "active", "ingilizce").map((b) => b.id)).toEqual(["b2"]);
  });

  it("shows the brands with language, accounts and status; a row opens the profile", async () => {
    const user = userEvent.setup();
    providers(<BrandsPage />, {}, seedBrands);
    const table = screen.getByRole("table", { name: "Markalar" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("button")[0]?.textContent)).toEqual([
      "Çiftçi Dostu",
      "MTM Agro",
    ]);
    const mtm = rows[1] as HTMLElement;
    expect(within(mtm).getByText("Seçili")).toBeInTheDocument();
    expect(within(mtm).getByText("mtm-agro")).toBeInTheDocument();
    expect(within(mtm).getByText("Türkçe")).toBeInTheDocument();
    expect(within(mtm).getByText("1 hesap bağlı")).toBeInTheDocument();
    expect(within(mtm).getByText("Etkin")).toBeInTheDocument();
    expect(within(mtm).getByText("Profil yok")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("İngilizce")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Arşiv/ }));
    expect(
      screen.getByRole("button", { name: "Eski Marka: marka profilini aç" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /MTM Agro/ })).toBeNull();
    expect(screen.getByText("Arşivde")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Markalarda ara" }), "mtm");
    // The whole row opens the profile.
    await user.click(screen.getByText("Türkçe"));
    expect(useAppStore.getState().route).toEqual({ kind: "brand", id: "b1" });
    // Back returns to the list.
    useAppStore.getState().goBack();
    expect(useAppStore.getState().route).toEqual({ kind: "brands" });
  });

  it("opens the new brand sheet", async () => {
    providers(<BrandsPage />, {}, seedBrands);
    await userEvent.click(screen.getByRole("button", { name: "Yeni marka" }));
    expect(screen.getByRole("dialog", { name: "Yeni marka" })).toBeInTheDocument();
  });

  it("says when there is no brand yet", () => {
    providers(<BrandsPage />, {}, (q) => q.setQueryData(queryKeys.brands, []));
    expect(screen.getByText("Henüz marka yok.")).toBeInTheDocument();
  });
});

describe("brand profile sections", () => {
  it("has exactly Genel, Marka Kiti, Profil, Hesaplar, Ürünler, Şablonlar; a section is a history step", async () => {
    expect(BRAND_TAB_OPTIONS.map((o) => o.label)).toEqual([
      "Genel",
      "Marka Kiti",
      "Profil",
      "Hesaplar",
      "Ürünler",
      "Şablonlar",
    ]);
    useAppStore.getState().navigate({ kind: "brand", id: "b1" });
    providers(<BrandPage brandId="b1" tab="kit" />, {}, (q) => {
      seedBrands(q);
      q.setQueryData(productKeys.list("b1"), []);
    });
    const tabs = screen.getByRole("radiogroup", { name: "Bölüm" });
    expect(
      within(tabs)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Genel", "Marka Kiti", "Profil", "Hesaplar", "Ürünler", "Şablonlar"]);
    expect(within(tabs).getByRole("radio", { name: "Marka Kiti" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(tabs).getByRole("radio", { name: "Ürünler" }));
    expect(useAppStore.getState().route).toEqual({ kind: "brand", id: "b1", tab: "products" });
    useAppStore.getState().goBack();
    expect(useAppStore.getState().route).toEqual({ kind: "brand", id: "b1" });

    await userEvent.click(screen.getByRole("button", { name: "‹ Markalar" }));
    expect(useAppStore.getState().route).toEqual({ kind: "brands" });
  });

  it("saves a kit edit right away when the section changes", async () => {
    const put = vi.fn(async (_brandId: string, kit: Record<string, unknown>) => ({
      ...kit,
      brandId: "b1",
      updatedAt: T,
    }));
    const { rerender, queryClient } = providers(
      <BrandPage brandId="b1" tab="kit" />,
      { brandKits: { put } },
      (q) => {
        seedBrands(q);
        q.setQueryData(brandKeys.kit("b1"), emptyBrandKit("b1"));
      },
    );
    fireEvent.change(await screen.findByRole("textbox", { name: "Notlar" }), {
      target: { value: "Hedef kitle: çiftçiler" },
    });
    expect(put).not.toHaveBeenCalled();
    rerender(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={{ brandKits: { put } } as unknown as ApiClient}>
          <BrandPage brandId="b1" tab="general" />
        </ApiContext.Provider>
      </QueryClientProvider>,
    );
    expect(put).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({ notes: "Hedef kitle: çiftçiler" }),
    );
  });

  it("shows the products section", () => {
    providers(<BrandPage brandId="b1" tab="products" />, {}, (q) => {
      seedBrands(q);
      q.setQueryData(productKeys.list("b1"), [product("p1", { name: "Yaprak gübresi" })]);
    });
    expect(screen.getByRole("article", { name: "Yaprak gübresi" })).toBeInTheDocument();
  });
});

describe("products model", () => {
  it("adds typed tags once, trimmed, up to the limit", () => {
    expect(addTags([], " organik, #Sıvı ,, organik ")).toEqual(["organik", "Sıvı"]);
    expect(addTags(["İlaç"], "ilaç, yeni")).toEqual(["İlaç", "yeni"]);
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(addTags(many, "fazla")).toHaveLength(12);
    expect(addTags([], "x".repeat(60))[0]).toHaveLength(40);
  });

  it("checks the draft and sends only what changed", () => {
    expect(productProblem(productDraft())).toBe("Ürün adı boş olamaz.");
    expect(productProblem({ ...productDraft(), name: "A", description: "x".repeat(501) })).toMatch(
      /Kısa açıklama/,
    );
    expect(productProblem({ ...productDraft(), name: "Gübre" })).toBeNull();

    const p = product("p1", { name: "Gübre", tags: ["a"], imageAssetIds: ["i1", "i2"] });
    expect(productPatch(p, productDraft(p))).toBeNull();
    expect(
      productPatch(p, {
        ...productDraft(p),
        name: "  Gübre 2 ",
        imageAssetIds: makeCover(["i1", "i2"], "i2"),
      }),
    ).toEqual({ name: "Gübre 2", imageAssetIds: ["i2", "i1"] });
  });

  it("searches name, category, tags and description", () => {
    const p = product("p1", {
      name: "Yaprak Gübresi",
      category: "Gübre",
      tags: ["organik"],
      description: "Sıvı form",
    });
    expect(productMatches(p, "YAPRAK")).toBe(true);
    expect(productMatches(p, "organik")).toBe(true);
    expect(productMatches(p, "sıvı")).toBe(true);
    expect(productMatches(p, "tohum")).toBe(false);
    expect(productMatches(p, "  ")).toBe(true);
  });
});

describe("Ürünler tab", () => {
  function fakeApi(initial: BrandProduct[] = []) {
    let seq = 0;
    const store = [...initial];
    const brandProducts = {
      list: vi.fn(async () => ({ items: store, nextCursor: null })),
      create: vi.fn(async (brandId: string, input: Record<string, unknown>) => {
        const created = product(`new-${++seq}`, { brandId, ...input });
        store.push(created);
        return created;
      }),
      update: vi.fn(async (_brandId: string, id: string, input: Record<string, unknown>) => {
        const index = store.findIndex((p) => p.id === id);
        const updated = { ...(store[index] as BrandProduct), ...input };
        store[index] = updated;
        return updated;
      }),
      delete: vi.fn(async () => undefined),
    };
    const assets = {
      upload: vi.fn(async () => ({ id: `asset-${++seq}` })),
    };
    return { brandProducts, assets } as unknown as ApiClient & {
      brandProducts: typeof brandProducts;
      assets: typeof assets;
    };
  }

  const b1 = BRANDS[0] as Brand;

  it("adds a product with tags and a photo", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    providers(<ProductsTab brand={b1} />, api, (q) => q.setQueryData(productKeys.list("b1"), []));
    expect(screen.getByText("Henüz ürün yok.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ürün ekle" }));
    const sheet = screen.getByRole("dialog", { name: "Yeni ürün" });
    await waitFor(() =>
      expect(within(sheet).getByRole("textbox", { name: "Ürün adı" })).toHaveFocus(),
    );
    const add = within(sheet).getByRole("button", { name: "Ekle" });
    expect(add).toBeDisabled();
    await user.type(within(sheet).getByRole("textbox", { name: "Ürün adı" }), "Yaprak gübresi");
    await user.type(within(sheet).getByRole("textbox", { name: "Kategori" }), "Gübre");
    await user.type(within(sheet).getByRole("textbox", { name: "Kısa açıklama" }), "Sıvı, 1 L");
    await user.type(within(sheet).getByRole("textbox", { name: "Etiket ekle" }), "organik, sıvı");
    expect(within(sheet).getByRole("button", { name: "organik etiketini kaldır" })).toBeVisible();

    const file = new File(["x"], "urun.jpg", { type: "image/jpeg" });
    const input = sheet.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(within(sheet).getByText("Kapak")).toBeInTheDocument());
    expect(api.assets.upload).toHaveBeenCalledWith({
      file,
      brandId: "b1",
      kind: "image",
      source: "upload",
    });

    await user.click(add);
    await waitFor(() => expect(api.brandProducts.create).toHaveBeenCalled());
    expect(api.brandProducts.create).toHaveBeenCalledWith("b1", {
      name: "Yaprak gübresi",
      category: "Gübre",
      description: "Sıvı, 1 L",
      tags: ["organik", "sıvı"],
      notes: "",
      imageAssetIds: ["asset-1"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const card = screen.getByRole("article", { name: "Yaprak gübresi" });
    expect(within(card).getByText("Gübre")).toBeInTheDocument();
    expect(within(card).getByText("organik")).toBeInTheDocument();
  });

  it("edits only what changed, searches and deletes after confirming", async () => {
    const user = userEvent.setup();
    const items = [
      product("p1", { name: "Yaprak gübresi", category: "Gübre", tags: ["organik"] }),
      product("p2", { name: "Buğday tohumu", category: "Tohum" }),
    ];
    const api = fakeApi(items);
    providers(<ProductsTab brand={b1} />, api, (q) =>
      q.setQueryData(productKeys.list("b1"), items),
    );
    expect(screen.getAllByRole("article")).toHaveLength(2);

    await user.type(screen.getByRole("searchbox", { name: "Ürünlerde ara" }), "tohum");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Buğday tohumu",
    ]);
    await user.clear(screen.getByRole("searchbox", { name: "Ürünlerde ara" }));

    await user.click(screen.getByRole("button", { name: "Yaprak gübresi: düzenle" }));
    const sheet = screen.getByRole("dialog", { name: "Yaprak gübresi" });
    expect(within(sheet).getByRole("textbox", { name: "Kategori" })).toHaveValue("Gübre");
    // The sheet focuses its first field once it is shown.
    await waitFor(() =>
      expect(within(sheet).getByRole("textbox", { name: "Ürün adı" })).toHaveFocus(),
    );
    await user.type(within(sheet).getByRole("textbox", { name: "Notlar" }), "Hasat öncesi");
    await user.click(within(sheet).getByRole("button", { name: "Kaydet" }));
    await waitFor(() =>
      expect(api.brandProducts.update).toHaveBeenCalledWith("b1", "p1", { notes: "Hasat öncesi" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Buğday tohumu: seçenekler" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sil" }));
    const confirm = screen.getByRole("dialog", { name: "“Buğday tohumu” silinsin mi?" });
    await user.click(within(confirm).getByRole("button", { name: "Sil" }));
    await waitFor(() => expect(api.brandProducts.delete).toHaveBeenCalledWith("b1", "p2"));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  });

  it("waits while Studio's server is not ready", async () => {
    providers(<ProductsTab brand={b1} />, {}, (q) => {
      q.setQueryData(productKeys.list("b1"), undefined);
    });
    // Host down: queries wait; the tab shows it is loading.
    expect(screen.getByText("Yükleniyor…")).toBeInTheDocument();
  });
});
