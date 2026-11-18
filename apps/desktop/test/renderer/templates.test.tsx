// Brand templates (N9) and conversions (N10) on the desktop: the Şablonlar tab, "Bu şablonla
// yeni post" (manual fields, AI fill), the post's "…" entries and links, and Postlar's
// "Dönüştür".
import type { ApiClient, Brand, ContentTemplate, TemplateField } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { templateKeys } from "../../src/renderer/features/brand/templates-data.ts";
import {
  conversionBlocker,
  fieldCount,
  fillForm,
  fillProblem,
  templateBlocker,
  templateLine,
  templateUseInput,
} from "../../src/renderer/features/brand/templates-model.ts";
import { TemplatesTab } from "../../src/renderer/features/brand/templates-tab.tsx";
import { postMenu } from "../../src/renderer/features/post-detail/post-facts.ts";
import type { PostCard } from "../../src/renderer/features/posts/board.ts";
import { convertible } from "../../src/renderer/features/posts/convert-dialog.tsx";
import { postKeys } from "../../src/renderer/features/posts/data.ts";
import { PostLinks } from "../../src/renderer/features/posts/post-links.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { content, T } from "./post-fixtures.ts";

// The live job feed (StudioProvider) is not mounted here: no jobs, worker offline.
vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, useJobs: () => ({ jobs: [], presence: null, controller: {} }) };
});

const brand: Brand = {
  id: "b1",
  name: "MTM Agro",
  slug: "mtm-agro",
  defaultLanguage: "tr",
  status: "active",
  createdAt: T,
  updatedAt: T,
};

const field = (
  over: Partial<TemplateField> & Pick<TemplateField, "key" | "label">,
): TemplateField => ({
  kind: "text",
  role: null,
  slide: 0,
  layer: over.key,
  nodeId: null,
  layerType: "text",
  example: "",
  maxChars: null,
  minFontSize: null,
  multiline: false,
  ratio: null,
  metrics: null,
  autoFit: true,
  locked: false,
  ...over,
});

const template = (over: Partial<ContentTemplate> = {}): ContentTemplate => ({
  id: "t1",
  brandId: "b1",
  name: "Ürün duyurusu",
  description: "",
  kind: "html",
  contentType: "post",
  width: 1080,
  height: 1350,
  slideCount: 1,
  fields: [
    field({
      key: "headline",
      label: "Başlık",
      role: "headline",
      example: "Hasat bitti",
      maxChars: 18,
    }),
    field({ key: "body", label: "Metin", role: "body", example: "Toprağınızı kışa hazırlayın." }),
    field({ key: "caption", label: "Not", example: "www.mtmagro.com", locked: true }),
    field({ key: "slot", label: "Görsel", kind: "image", layerType: "slot", ratio: "4:5" }),
  ],
  previewAssetIds: ["r1"],
  source: { contentId: "p0", version: 3, title: "Hasat" },
  editorDocument: null,
  useCount: 2,
  createdAt: T,
  updatedAt: T,
  ...over,
});

function providers(ui: ReactNode, api: unknown, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState({ route: { kind: "brand", id: "b1", tab: "templates" }, post: null });
  usePostsStore.setState({ opened: null });
});
afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

describe("template model", () => {
  it("describes a template and counts a field's characters against its hint", () => {
    expect(templateLine(template())).toBe("Post · 1080×1350 · 3 alan");
    expect(templateLine(template({ kind: "canvas", slideCount: 4, contentType: "carousel" }))).toBe(
      "Carousel · 4 kare · 1080×1350 · 3 alan · tuval",
    );
    const headline = template().fields[0] as TemplateField;
    expect(fieldCount(headline, "Kışa hazır mısınız, bayiye sorun")).toEqual({
      count: 32,
      limit: 18,
      over: true,
    });
  });

  it("sends only unlocked, filled fields; AI mode needs a subject", () => {
    const t = template();
    const form = fillForm(t);
    expect(fillProblem(t, form)).toBe("En az bir alanı doldur ya da AI doldursun.");
    form.values = { headline: "  Kış geliyor ", body: "", caption: "x" };
    form.images = { slot: "a9", headline: "zz" };
    expect(fillProblem(t, form)).toBeNull();
    expect(templateUseInput(t, form)).toEqual({
      title: "Ürün duyurusu",
      fill: "manual",
      autoFit: true,
      values: { headline: "Kış geliyor" },
      images: { slot: "a9" },
    });
    const ai = { ...fillForm(t), mode: "ai" as const };
    expect(fillProblem(t, ai)).toBe("AI'ın ne yazacağını (konu) yaz.");
    expect(templateUseInput(t, { ...ai, brief: "Kış bakımı" })).toMatchObject({
      fill: "ai",
      brief: "Kış bakımı",
    });
  });

  it("knows which posts can be templates and conversions", () => {
    expect(templateBlocker(content({ status: "draft" }))).toBe(
      "Önce onayla; şablon onaylı postlardan olur.",
    );
    expect(templateBlocker(content({ status: "published" }))).toBeNull();
    expect(templateBlocker(content({ type: "reel", status: "approved" }))).toBe(
      "Reels şablon olamaz.",
    );
    const ref = { id: "v1", version: 1, contentHash: "0".repeat(64) };
    expect(conversionBlocker(content({ currentVersion: ref }), "story")).toBeNull();
    expect(conversionBlocker(content({ type: "story", currentVersion: ref }), "story")).toBe(
      "Bu post zaten bir story.",
    );
    expect(conversionBlocker(content(), "reel")).toBe("Postun henüz tasarımı yok; önce üret.");
  });

  it("splits the picked posts of a bulk conversion", () => {
    const ref = { id: "v1", version: 1, contentHash: "0".repeat(64) };
    const card = (id: string, over: Parameters<typeof content>[0]): PostCard => ({
      id,
      content: content({ id, ...over }),
      version: null,
      planItem: null,
      schedule: null,
      job: null,
    });
    const { take, skip } = convertible(
      [card("a", { currentVersion: ref }), card("b", { type: "reel", currentVersion: ref })],
      "story",
    );
    expect(take.map((c) => c.id)).toEqual(["a"]);
    expect(skip.map((s) => [s.card.id, s.reason])).toEqual([
      ["b", "Reels başka bir türe dönüştürülemez."],
    ]);
  });
});

describe("Şablonlar tab", () => {
  it("lists the brand's templates and makes a post from one with the filled fields", async () => {
    const use = vi.fn(async (_id: string, input: Record<string, unknown>) => ({
      content: content({ id: "p9", title: String(input.title), templateId: "t1" }),
      job: {
        id: "j9",
        type: "content.generate",
        status: "queued",
        payload: {},
        createdAt: T,
        updatedAt: T,
      },
    }));
    const api = {
      templates: { use, list: async () => ({ items: [template()], nextCursor: null }) },
      contents: { list: async () => ({ items: [], nextCursor: null }) },
    };
    providers(<TemplatesTab brand={brand} />, api, (q) =>
      q.setQueryData(templateKeys.list("b1"), [template()]),
    );
    const list = screen.getByRole("list", { name: "Şablonlar" });
    const card = within(list).getByRole("article", { name: "Ürün duyurusu" });
    expect(within(card).getByText("Post · 1080×1350 · 3 alan")).toBeInTheDocument();
    expect(within(card).getByText(/2 kez kullanıldı · Kaynak: “Hasat” v3/)).toBeInTheDocument();

    await userEvent.click(
      within(card).getByRole("button", { name: "Ürün duyurusu: bu şablonla yeni post" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Bu şablonla yeni post" });
    // Locked fields are not offered.
    expect(within(sheet).queryByRole("textbox", { name: "Not" })).toBeNull();
    await userEvent.type(
      within(sheet).getByRole("textbox", { name: "Başlık" }),
      "Kışa hazır mısınız",
    );
    expect(within(sheet).getByText(/18 \/ ~18 karakter/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Postu oluştur" }));
    await waitFor(() => expect(use).toHaveBeenCalledTimes(1));
    expect(use.mock.calls[0]?.[0]).toBe("t1");
    expect(use.mock.calls[0]?.[1]).toEqual({
      title: "Ürün duyurusu",
      fill: "manual",
      autoFit: true,
      values: { headline: "Kışa hazır mısınız" },
    });
    await waitFor(() => expect(usePostsStore.getState().opened?.contentId).toBe("p9"));
  });

  it("lets the AI fill from a subject", async () => {
    const use = vi.fn(async () => ({
      content: content({ id: "p8" }),
      job: {
        id: "j8",
        type: "content.generate",
        status: "queued",
        payload: {},
        createdAt: T,
        updatedAt: T,
      },
    }));
    providers(<TemplatesTab brand={brand} />, { templates: { use } }, (q) =>
      q.setQueryData(templateKeys.list("b1"), [template()]),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ürün duyurusu: bu şablonla yeni post" }),
    );
    const sheet = screen.getByRole("dialog", { name: "Bu şablonla yeni post" });
    await userEvent.click(within(sheet).getByRole("radio", { name: "AI doldursun" }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Konu" }), "Kış bakımı");
    await userEvent.click(within(sheet).getByRole("button", { name: "Postu oluştur" }));
    await waitFor(() =>
      expect(use).toHaveBeenCalledWith("t1", {
        title: "Ürün duyurusu",
        fill: "ai",
        autoFit: true,
        brief: "Kış bakımı",
      }),
    );
  });

  it("says how to make one when the brand has none", () => {
    providers(<TemplatesTab brand={brand} />, {}, (q) =>
      q.setQueryData(templateKeys.list("b1"), []),
    );
    expect(screen.getByText("Henüz şablon yok.")).toBeInTheDocument();
  });
});

describe("a post's links and menu", () => {
  it("shows the source post, the template and the conversions; each opens", async () => {
    const story = content({
      id: "s1",
      type: "story",
      title: "Hasat · Story",
      templateId: "t1",
      source: { contentId: "p0", version: 3, kind: "story" },
    });
    providers(
      <PostLinks content={story} />,
      { contents: { list: async () => ({ items: [], nextCursor: null }) } },
      (q) => {
        q.setQueryData(postKeys.content("p0"), content({ id: "p0", title: "Hasat" }));
        q.setQueryData(templateKeys.list("b1"), [template()]);
        q.setQueryData(templateKeys.derived("s1"), []);
      },
    );
    const links = screen.getByRole("region", { name: "Bağlantılar" });
    await userEvent.click(within(links).getByRole("button", { name: "“Hasat” postu (v3)" }));
    expect(usePostsStore.getState().opened?.contentId).toBe("p0");
    await userEvent.click(within(links).getByRole("button", { name: "“Ürün duyurusu”" }));
    expect(useAppStore.getState().route).toEqual({ kind: "brand", id: "b1", tab: "templates" });

    const source = content({ id: "p0", title: "Hasat" });
    providers(<PostLinks content={source} />, {}, (q) =>
      q.setQueryData(templateKeys.derived("p0"), [story]),
    );
    expect(screen.getByText("Dönüştürülenler:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hasat · Story" })).toBeInTheDocument();
  });

  it("puts the template and conversion entries before duplicate and delete", () => {
    const entries = postMenu({
      content: content(),
      version: null,
      actions: {} as never,
      quickLook: () => {},
      openInChat: () => {},
      conversionEntries: [
        { id: "save-template", label: "Şablon olarak kaydet…" },
        { id: "repurpose-story", label: "Story'ye dönüştür" },
      ],
    });
    const ids = entries.map((e) => ("id" in e ? e.id : e.type));
    expect(ids.indexOf("save-template")).toBeLessThan(ids.indexOf("duplicate"));
    expect(ids.indexOf("repurpose-story")).toBeLessThan(ids.indexOf("delete"));
  });
});
