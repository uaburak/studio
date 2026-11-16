import { computeContentHash } from "@studio/contract";
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
} from "./helpers.tsx";

const T = "2026-11-16T10:00:00.000Z";

const EDITOR_SLIDE_HTML = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:format" content="1080x1350">
</head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty"
            data-slot-label="Saha fotoğrafı" style="position:absolute;left:60px;top:60px;width:400px;height:500px"></figure>
    <h1 data-layer="headline" data-type="text" style="position:absolute;left:60px;top:620px;width:800px;font-size:64px">İlk Başlık</h1>
  </main>
</body>
</html>`;

describe("Interactive HTML Slide Editor flows", () => {
  it("edits text layers, supports undo/redo, fills visual slots via Gemini AI with product label preservation, exports LinkedIn PDF, and runs Prompt ile düzelt preserving edits", async () => {
    const api = createMockApi();
    const slides = [{ html: EDITOR_SLIDE_HTML, width: 1080, height: 1350 }];
    const hash = await computeContentHash(slides);
    const v1 = {
      id: "ver-1",
      contentId: "content-1",
      version: 1,
      origin: "generated" as const,
      contentHash: hash,
      slideCount: 1,
      note: null,
      jobId: null,
      createdAt: T,
      updatedAt: T,
      slides: [
        { ...slides[0], renderedAssetId: null } as {
          html: string;
          width: number;
          height: number;
          renderedAssetId: string | null;
        },
      ],
    };
    const content = contentFixture({
      type: "post",
      currentVersion: { id: "ver-1", version: 1, contentHash: hash },
    });

    api.brands.list.mockImplementation(() => page([brand()]));
    api.contents.get.mockResolvedValue(content);
    api.contents.versions.list.mockImplementation(() => page([v1]));
    api.contents.versions.get.mockResolvedValue(v1);

    api.contents.versions.create.mockImplementation(async (_id, input) => {
      const nextHash = await computeContentHash(input.slides);
      return {
        id: "ver-2",
        contentId: "content-1",
        version: 2,
        origin: input.origin,
        contentHash: nextHash,
        slideCount: input.slides.length,
        note: input.note ?? null,
        jobId: null,
        createdAt: T,
        updatedAt: T,
        slides: input.slides.map((s) => ({ ...s, renderedAssetId: null })),
      };
    });

    api.jobs.create.mockImplementation(async (input) => ({
      id: `job-${input.type}`,
      type: input.type,
      status: "queued" as const,
      brandId: input.brandId,
      contentId: input.contentId,
      payload: input.payload ?? {},
      createdAt: T,
      updatedAt: T,
    }));

    const user = userEvent.setup();
    renderRoute("/icerikler/content-1", api);

    // Select headline layer in Layer List
    const headlineBtn = await screen.findByRole("button", { name: /headline.*Metin/i });
    await user.click(headlineBtn);

    const textInput = screen.getByLabelText("Metin");
    expect(textInput).toHaveValue("İlk Başlık");

    await user.clear(textInput);
    await user.type(textInput, "Güncel Başlık");
    expect(textInput).toHaveValue("Güncel Başlık");

    // Undo and Redo via toolbar buttons
    await user.click(screen.getByRole("button", { name: "Geri al" }));
    expect(screen.getByLabelText("Metin")).toHaveValue("İlk Başlık");

    await user.click(screen.getByRole("button", { name: "Yinele" }));
    expect(screen.getByLabelText("Metin")).toHaveValue("Güncel Başlık");

    // Open Visual Slot Fill on empty slot and trigger Gemini AI image generation with preserveProductLabel
    await user.click(screen.getByRole("button", { name: /field-photo.*Görsel yuvası/i }));
    await user.click(screen.getByRole("button", { name: "Yuvayı doldur" }));

    const slotDialog = await screen.findByRole("dialog", { name: /Görsel yuvası: Saha fotoğrafı/ });
    await user.click(within(slotDialog).getByLabelText("Gemini ile üret"));
    const aiPrompt = within(slotDialog).getByLabelText("Görsel istemi (prompt)");
    await user.clear(aiPrompt);
    await user.type(aiPrompt, "Sabah güneşinde yeşil buğday tarlası");
    await user.click(within(slotDialog).getByText("Ürün etiketini koru"));
    await user.click(within(slotDialog).getByRole("button", { name: "Gemini ile üret" }));

    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "image.generate",
          brandId: "brand-1",
          payload: expect.objectContaining({
            prompt: "Sabah güneşinde yeşil buğday tarlası",
            preserveProductLabel: true,
            targetSlotId: "field-photo",
          }),
        }),
      ),
    );
    await user.click(within(slotDialog).getByRole("button", { name: "Vazgeç" }));

    // Prompt ile düzelt saves dirty manual edits first as v2 (baseVersion: 2) then queues content.generate
    const fixInput = screen.getByLabelText("Prompt ile düzeltme talimatı");
    await user.type(fixInput, "Kontrastı güçlendir");
    await user.click(screen.getByRole("button", { name: "Prompt ile düzelt" }));

    await waitFor(() =>
      expect(api.contents.versions.create).toHaveBeenCalledWith(
        "content-1",
        expect.objectContaining({
          origin: "manual_edit",
        }),
      ),
    );
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "content.generate",
          contentId: "content-1",
          payload: expect.objectContaining({
            baseVersion: 2,
            instructions: "Kontrastı güçlendir",
          }),
        }),
      ),
    );

    // LinkedIn PDF export
    await user.click(screen.getByRole("button", { name: "LinkedIn PDF" }));
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "content.render",
          contentId: "content-1",
          payload: expect.objectContaining({ format: "pdf" }),
        }),
      ),
    );
  });
});

describe("Brand Profile analyze, Social Account connection & Schedule permalink", () => {
  it("triggers brand.analyze, connects Meta & LinkedIn accounts with token health badges", async () => {
    const api = createMockApi();
    const b = brand();
    api.brands.list.mockImplementation(() => page([b]));
    api.brands.get.mockResolvedValue(b);
    api.socialAccounts.list.mockImplementation(() =>
      page([
        account({
          id: "acc-ig",
          platform: "instagram",
          handle: "@mtmagro",
          status: "connected",
          hasToken: true,
          tokenHealth: "valid",
          tokenExpiresAt: "2027-01-15T00:00:00.000Z",
        }),
      ]),
    );
    api.jobs.create.mockImplementation(async (input) => ({
      id: "job-analyze-1",
      type: input.type,
      status: "queued" as const,
      brandId: input.brandId,
      payload: input.payload ?? {},
      createdAt: T,
      updatedAt: T,
    }));
    api.socialAccounts.discoverMeta.mockResolvedValue({
      pages: [
        {
          pageId: "12345",
          pageName: "MTM Agro Resmi",
          canPublish: true,
          instagram: { igUserId: "999", username: "mtmagro" },
        },
      ],
      connectedAccounts: [account({ status: "connected" })],
    });
    api.socialAccounts.connectLinkedIn.mockImplementation(async (input) =>
      account({
        id: "acc-li",
        platform: "linkedin",
        handle: input.handle,
        externalId: input.personUrn,
        status: "connected",
      }),
    );

    const user = userEvent.setup();
    renderRoute("/markalar/brand-1", api);

    // Token health badge rendered
    expect(await screen.findByText("Token sağlıklı")).toBeInTheDocument();

    // Trigger brand.analyze
    const analyzeBtns = screen.getAllByRole("button", { name: "AI ile analiz et" });
    await user.click(analyzeBtns[0] as HTMLElement);
    const analyzeDialog = await screen.findByRole("dialog", { name: "AI ile Marka Profili Çıkar" });
    await user.type(
      within(analyzeDialog).getByLabelText(/Marka notları/),
      "Teknik ve sade tarım dili",
    );
    await user.click(within(analyzeDialog).getByRole("button", { name: "Analizi başlat" }));

    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "brand.analyze",
          brandId: "brand-1",
          payload: expect.objectContaining({ notes: "Teknik ve sade tarım dili" }),
        }),
      ),
    );

    // Connect Meta
    await user.click(screen.getByRole("button", { name: "Meta bağla" }));
    const metaDialog = await screen.findByRole("dialog", {
      name: "Meta (Instagram ve Facebook) Bağla",
    });
    await user.type(
      within(metaDialog).getByLabelText("Facebook Kullanıcı Erişim Token'ı"),
      "EAABmocktoken12345",
    );
    await user.click(within(metaDialog).getByRole("button", { name: "Sayfaları keşfet ve bağla" }));
    await waitFor(() =>
      expect(api.socialAccounts.discoverMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: "brand-1",
          userAccessToken: "EAABmocktoken12345",
          autoConnect: true,
        }),
      ),
    );
    expect(await within(metaDialog).findByText("MTM Agro Resmi")).toBeInTheDocument();
    await user.click(within(metaDialog).getByRole("button", { name: "Vazgeç" }));

    // Connect LinkedIn
    await user.click(screen.getByRole("button", { name: "LinkedIn bağla" }));
    const liDialog = await screen.findByRole("dialog", { name: "LinkedIn Profilini Bağla" });
    await user.type(within(liDialog).getByLabelText("Profil adı"), "Burak Koç");
    await user.type(
      within(liDialog).getByLabelText("Person URN / Üye Kimliği"),
      "urn:li:person:burak1",
    );
    await user.type(
      within(liDialog).getByLabelText("Erişim Token'ı (w_member_social)"),
      "AQVmocklinkedintoken",
    );
    await user.click(within(liDialog).getByRole("button", { name: "LinkedIn bağla" }));
    await waitFor(() =>
      expect(api.socialAccounts.connectLinkedIn).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: "brand-1",
          handle: "Burak Koç",
          personUrn: "urn:li:person:burak1",
          accessToken: "AQVmocklinkedintoken",
        }),
      ),
    );
  });

  it("displays published permalink in Takvim schedule detail dialog", async () => {
    const api = createMockApi();
    const now = new Date();
    const inThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 9, 0));
    const publishedSchedule = scheduleFixture({
      scheduledAt: inThisMonth.toISOString(),
      status: "published",
      permalink: "https://www.instagram.com/p/C123456/",
    });
    api.brands.list.mockImplementation(() => page([brand()]));
    api.schedules.list.mockImplementation(() => page([publishedSchedule]));
    api.contents.get.mockResolvedValue(contentFixture({ status: "published" }));
    api.socialAccounts.get.mockResolvedValue(account({ status: "connected" }));

    const user = userEvent.setup();
    renderRoute("/takvim?gorunum=liste", api);

    await user.click(await screen.findByRole("button", { name: /Kasım kampanyası/ }));
    const dialog = await screen.findByRole("dialog", { name: "Kasım kampanyası" });
    const link = within(dialog).getByRole("link", { name: /Paylaşımı görüntüle/ });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/p/C123456/");
  });
});
