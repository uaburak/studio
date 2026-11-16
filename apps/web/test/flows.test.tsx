import { ApiError } from "@studio/contract";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  account,
  brand,
  contentFixture,
  createMockApi,
  page,
  renderRoute,
  scheduleFixture,
  versionFixture,
} from "./helpers.tsx";

describe("Markalar", () => {
  it("lists brands and creates a new one", async () => {
    const api = createMockApi();
    api.brands.list.mockImplementation(() => page([brand()]));
    api.brands.create.mockImplementation(async (input) =>
      brand({ id: "brand-2", name: input.name, slug: "venta" }),
    );
    api.brands.get.mockImplementation(async (id) => brand({ id, name: "Venta", slug: "venta" }));
    const user = userEvent.setup();
    const { router } = renderRoute("/markalar", api);

    expect(await screen.findByRole("heading", { name: "MTM Agro" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Yeni marka" }));
    const dialog = await screen.findByRole("dialog", { name: "Yeni marka" });
    await user.type(within(dialog).getByLabelText("Marka adı"), "Venta");
    expect(within(dialog).getByText("Boş bırakılırsa: venta")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Oluştur" }));

    await waitFor(() =>
      expect(api.brands.create).toHaveBeenCalledWith({ name: "Venta", defaultLanguage: "tr" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/markalar/brand-2"));
  });

  it("shows validation errors from the API next to the form", async () => {
    const api = createMockApi();
    api.brands.create.mockRejectedValue(
      new ApiError("/api/brands: slug already exists", 409, "conflict"),
    );
    const user = userEvent.setup();
    renderRoute("/markalar", api);

    await user.click(await screen.findByRole("button", { name: "İlk markayı oluştur" }));
    const dialog = await screen.findByRole("dialog", { name: "Yeni marka" });
    await user.type(within(dialog).getByLabelText("Marka adı"), "MTM");
    await user.click(within(dialog).getByRole("button", { name: "Oluştur" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "İşlem şu anki durumla çakışıyor",
    );
    expect(within(dialog).getByText("slug already exists")).toBeInTheDocument();
  });
});

describe("İçerik detayı", () => {
  async function setup(contentPatch = {}) {
    const api = createMockApi();
    const version = await versionFixture();
    const content = contentFixture({
      currentVersion: { id: version.id, version: 1, contentHash: version.contentHash },
      ...contentPatch,
    });
    api.brands.list.mockImplementation(() => page([brand()]));
    api.contents.get.mockResolvedValue(content);
    api.contents.versions.list.mockImplementation(() => page([version]));
    api.contents.versions.get.mockResolvedValue(version);
    return { api, version, content };
  }

  it("renders slides in script-less sandboxed iframes with a no-network CSP", async () => {
    const { api } = await setup();
    renderRoute("/icerikler/content-1", api);

    const stage = await screen.findByRole("img", { name: "Slayt 1 / 2" });
    const frame = stage.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none';`,
    );
    expect(frame?.getAttribute("width")).toBe("1080");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sonraki slayt" }));
    expect(await screen.findByRole("img", { name: "Slayt 2 / 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sonraki slayt" })).toBeDisabled();
  });

  it("approves the current version by its recomputed hash", async () => {
    const { api, version, content } = await setup();
    api.contents.approve.mockResolvedValue({
      ...content,
      status: "approved",
      approval: {
        versionId: version.id,
        contentHash: version.contentHash,
        approvedAt: content.updatedAt,
      },
    });
    const user = userEvent.setup();
    renderRoute("/icerikler/content-1", api);

    expect(await screen.findByText("doğrulandı")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "v1 sürümünü onayla" }));
    await waitFor(() =>
      expect(api.contents.approve).toHaveBeenCalledWith("content-1", version.contentHash),
    );
    expect(await screen.findByRole("button", { name: "Onayı geri çek" })).toBeInTheDocument();
  });

  it("shows a hash conflict clearly and refetches", async () => {
    const { api } = await setup();
    api.contents.approve.mockRejectedValue(
      new ApiError("/api/contents/content-1/approve: a newer version exists", 409, "hash_mismatch"),
    );
    const user = userEvent.setup();
    renderRoute("/icerikler/content-1", api);

    await screen.findByText("doğrulandı");
    const before = api.contents.get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "v1 sürümünü onayla" }));
    expect(await screen.findByText(/Sürüm değişti/)).toBeInTheDocument();
    expect(screen.getByText("a newer version exists")).toBeInTheDocument();
    await waitFor(() => expect(api.contents.get.mock.calls.length).toBeGreaterThan(before));
  });

  it("queues a content.generate job from Üret", async () => {
    const { api } = await setup();
    api.jobs.create.mockImplementation(async (input) => ({
      id: "job-1",
      type: input.type,
      status: "queued" as const,
      payload: input.payload ?? {},
      contentId: input.contentId,
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    }));
    const user = userEvent.setup();
    renderRoute("/icerikler/content-1", api);

    await user.click(await screen.findByRole("button", { name: "Üret" }));
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith({
        type: "content.generate",
        contentId: "content-1",
        payload: expect.objectContaining({ brief: "Yeni tohum serisi", type: "carousel" }),
      }),
    );
    expect(await screen.findByText("Üretim işi kuyruğa eklendi")).toBeInTheDocument();
  });

  it("schedules an approved item, converting local time to UTC", async () => {
    const version = await versionFixture();
    const { api } = await setup({
      status: "approved",
      approval: {
        versionId: version.id,
        contentHash: version.contentHash,
        approvedAt: "2026-11-16T10:00:00.000Z",
      },
    });
    api.socialAccounts.list.mockImplementation(() =>
      page([account(), account({ id: "acc-2", platform: "linkedin", handle: "Burak" })]),
    );
    api.schedules.create.mockImplementation(async (input) =>
      scheduleFixture({ scheduledAt: input.scheduledAt, socialAccountId: input.socialAccountId }),
    );
    const user = userEvent.setup();
    renderRoute("/icerikler/content-1", api);

    await user.click(await screen.findByRole("button", { name: "Zamanla" }));
    const dialog = await screen.findByRole("dialog", { name: "Zamanla" });
    const accountSelect = within(dialog).getByLabelText("Hesap");
    // Only accounts on the content's target platforms are offered.
    await waitFor(() => expect(within(accountSelect).getAllByRole("option")).toHaveLength(1));

    const date = within(dialog).getByLabelText("Tarih");
    const time = within(dialog).getByLabelText("Saat");
    await user.clear(date);
    await user.type(date, "2030-01-15");
    await user.clear(time);
    await user.type(time, "09:30");
    expect(within(dialog).getByText("2030-01-15T06:30:00Z")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Zamanla" }));
    await waitFor(() =>
      expect(api.schedules.create).toHaveBeenCalledWith({
        contentId: "content-1",
        socialAccountId: "acc-1",
        scheduledAt: "2030-01-15T06:30:00.000Z",
      }),
    );
  });
});

describe("İçerikler", () => {
  it("filters by status through the API and creates content with a generate job", async () => {
    const api = createMockApi();
    api.brands.list.mockImplementation(() => page([brand()]));
    api.contents.list.mockImplementation(() => page([contentFixture()]));
    api.contents.create.mockImplementation(async (input) =>
      contentFixture({ id: "content-9", title: input.title, type: input.type }),
    );
    api.contents.get.mockImplementation(async (id) => contentFixture({ id }));
    api.jobs.create.mockImplementation(async (input) => ({
      id: "job-9",
      type: input.type,
      status: "queued" as const,
      payload: {},
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    }));
    const user = userEvent.setup();
    const { router } = renderRoute("/icerikler", api);

    expect(await screen.findByText("Kasım kampanyası")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Durum"), "approved");
    await waitFor(() =>
      expect(api.contents.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "approved" }),
        expect.anything(),
      ),
    );
    expect(router.state.location.search).toBe("?durum=approved");

    await user.click(screen.getByRole("button", { name: "Yeni içerik" }));
    const dialog = await screen.findByRole("dialog", { name: "Yeni içerik" });
    await user.type(within(dialog).getByLabelText("Başlık"), "Tohum serisi");
    await user.type(within(dialog).getByLabelText("Brif"), "Beş slaytlık tanıtım");
    await user.click(within(dialog).getByLabelText("Carousel"));
    await user.click(within(dialog).getByRole("button", { name: "Oluştur" }));

    await waitFor(() =>
      expect(api.contents.create).toHaveBeenCalledWith({
        brandId: "brand-1",
        type: "carousel",
        title: "Tohum serisi",
        brief: "Beş slaytlık tanıtım",
        targetPlatforms: ["instagram"],
      }),
    );
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: "content.generate", contentId: "content-9" }),
      ),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/icerikler/content-9"));
  });
});

describe("Takvim", () => {
  it("cancels a pending schedule after confirmation", async () => {
    const api = createMockApi();
    const now = new Date();
    const inThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 9, 0));
    const schedule = scheduleFixture({ scheduledAt: inThisMonth.toISOString() });
    api.brands.list.mockImplementation(() => page([brand()]));
    api.schedules.list.mockImplementation(() => page([schedule]));
    api.contents.get.mockResolvedValue(contentFixture({ status: "scheduled" }));
    api.socialAccounts.get.mockResolvedValue(account());
    api.schedules.cancel.mockResolvedValue({ ...schedule, status: "cancelled" });
    const user = userEvent.setup();
    renderRoute("/takvim?gorunum=liste", api);

    const chip = await screen.findByRole("button", { name: /Kasım kampanyası/ });
    await user.click(chip);
    const dialog = await screen.findByRole("dialog", { name: "Kasım kampanyası" });
    expect(within(dialog).getByText(/Henüz otomatik paylaşılmayacak/)).toBeInTheDocument();
    expect(within(dialog).getByText("Henüz yayın denemesi yok.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Zamanlamayı iptal et" }));
    await user.click(within(dialog).getByRole("button", { name: "Evet, iptal et" }));
    await waitFor(() => expect(api.schedules.cancel).toHaveBeenCalledWith("sch-1"));
  });
});
