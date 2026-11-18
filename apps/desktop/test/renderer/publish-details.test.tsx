// N13 "Yayın ayrıntıları" (model and section), the schedule sheet's suggested times (N15) and the
// accounts' reconnect hint for the statistics / comment permissions.
import {
  type ApiClient,
  type BestTimes,
  type Content,
  nextSlotTime,
  type PublishDetails,
  type SocialAccount,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountRows,
  ENGAGEMENT_RECONNECT_HINT,
  engagementHint,
} from "../../src/renderer/features/accounts/model.ts";
import { PublishDetailsSection } from "../../src/renderer/features/post-detail/publish-details.tsx";
import {
  autoAltTexts,
  commentUsage,
  detailFields,
  detailsPayload,
  detailsSummary,
  editAltText,
  issueLines,
  normalizeUsername,
  parseUsernames,
  publishKinds,
  sameDetails,
  slideText,
  tagPosition,
} from "../../src/renderer/features/post-detail/publish-details-model.ts";
import {
  bestTimesPlatform,
  ScheduleSheet,
} from "../../src/renderer/features/post-detail/schedule-sheet.tsx";
import { dateInput, timeInput } from "../../src/renderer/features/posts/dates.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import {
  account,
  content,
  contentFor,
  preflight,
  SLIDE_HTML,
  slide,
  version,
} from "./post-fixtures.ts";

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

function wrap(ui: ReactNode, api: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

const AUTO_TEXT = "Görselde yazan: Hasat bitti, toprak hazır mı? Organik madde & kış";

describe("which details a post shows", () => {
  it("follows the platforms and the post type", () => {
    const ig = detailFields(publishKinds(content({ targetPlatforms: ["instagram"] }), 1));
    expect(ig).toEqual({
      firstComment: true,
      altText: true,
      location: true,
      collaborators: true,
      userTags: true,
      reelCover: false,
      shareToFeed: false,
    });
    const reel = detailFields(
      publishKinds(content({ type: "reel", targetPlatforms: ["instagram"] }), 1),
    );
    expect(reel).toMatchObject({
      altText: false,
      reelCover: true,
      shareToFeed: true,
      userTags: true,
    });
    const fb = detailFields(publishKinds(content({ targetPlatforms: ["facebook"] }), 1));
    expect(
      Object.entries(fb)
        .filter(([, on]) => on)
        .map(([k]) => k),
    ).toEqual(["firstComment", "altText"]);
    const li = detailFields(publishKinds(content({ targetPlatforms: ["linkedin"] }), 1));
    expect(
      Object.entries(li)
        .filter(([, on]) => on)
        .map(([k]) => k),
    ).toEqual(["altText"]);
    const story = detailFields(
      publishKinds(content({ type: "story", targetPlatforms: ["instagram", "facebook"] }), 1),
    );
    expect(Object.values(story).some(Boolean)).toBe(false);
  });

  it("counts the first comment against the strictest platform", () => {
    const kinds = publishKinds(content({ targetPlatforms: ["instagram", "facebook"] }), 1);
    expect(commentUsage("#a #b selam", kinds)).toMatchObject({
      max: 2200,
      hashtags: 2,
      hashtagLimit: 30,
      over: false,
      label: "11 / 2.200 karakter · 2/30 etiket",
    });
    const fbOnly = publishKinds(content({ targetPlatforms: ["facebook"] }), 1);
    expect(commentUsage("x".repeat(3000), fbOnly)).toMatchObject({
      max: 8000,
      hashtagLimit: null,
      over: false,
    });
    expect(commentUsage("x".repeat(2201), kinds).over).toBe(true);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(commentUsage(tags, kinds).over).toBe(true);
  });
});

describe("details model", () => {
  it("normalises usernames", () => {
    expect(normalizeUsername("  @Ali.Veli_ ")).toBe("ali.veli_");
    expect(normalizeUsername("ali veli")).toBeNull();
    expect(normalizeUsername("@")).toBeNull();
    expect(parseUsernames("@Ortak, ayse  ortak ali!veli")).toEqual({
      usernames: ["ortak", "ayse"],
      invalid: ["ali!veli"],
    });
  });

  it("turns a click into a 0–1 position", () => {
    const rect = { left: 100, top: 50, width: 200, height: 250 };
    expect(tagPosition(rect, 200, 175)).toEqual({ x: 0.5, y: 0.5 });
    expect(tagPosition(rect, 90, 400)).toEqual({ x: 0, y: 1 });
    expect(tagPosition(rect, 133.3333, 50)).toEqual({ x: 0.167, y: 0 });
  });

  it("reads a slide's visible words and fills alternative texts nobody wrote", () => {
    expect(slideText(SLIDE_HTML)).toBe("Hasat bitti, toprak hazır mı? Organik madde & kış");
    expect(
      slideText("<html><body><p>Yalnız <b>metin</b></p><style>p{}</style></body></html>"),
    ).toBe("Yalnız metin");
    const slides = [{ html: SLIDE_HTML }, { html: "<html><body>İkinci kare</body></html>" }];
    const filled = autoAltTexts({}, slides);
    expect(filled.altTexts).toEqual([AUTO_TEXT, "Görselde yazan: İkinci kare"]);
    expect(filled.altTextSources).toEqual(["auto", "auto"]);
    // The owner's text stays, even when rewriting the automatic ones.
    const edited = editAltText(filled, 0, "Tarlada buğday");
    expect(edited.altTextSources).toEqual(["manual", "auto"]);
    const again = autoAltTexts(
      editAltText(edited, 1, "Benim yazım"),
      [{ html: SLIDE_HTML }, { html: "<html><body>Yeni yazı</body></html>" }],
      { force: true },
    );
    expect(again.altTexts).toEqual(["Tarlada buğday", "Benim yazım"]);
    const auto = autoAltTexts(
      edited,
      [{ html: SLIDE_HTML }, { html: "<html><body>Yeni</body></html>" }],
      {
        force: true,
      },
    );
    expect(auto.altTexts).toEqual(["Tarlada buğday", "Görselde yazan: Yeni"]);
    // Nothing to fill: the same object.
    expect(autoAltTexts(edited, [{ html: "<html><body></body></html>" }])).toBe(edited);
  });

  it("sends only what is set and compares by that", () => {
    const d: PublishDetails = {
      firstComment: "  #hasat ",
      altTexts: ["  ", null],
      altTextSources: ["auto", null],
      collaborators: ["a", "a"],
      userTags: [],
      shareToFeed: true,
    };
    expect(detailsPayload(d)).toEqual({ firstComment: "#hasat", collaborators: ["a"] });
    expect(sameDetails(d, { firstComment: "#hasat", collaborators: ["a"] })).toBe(true);
    expect(sameDetails(d, null)).toBe(false);
    expect(sameDetails({}, null)).toBe(true);
  });

  it("lists the platforms' errors first, then what is left out", () => {
    const kinds = publishKinds(content({ targetPlatforms: ["instagram", "facebook"] }), 1);
    const lines = issueLines(
      { firstComment: "a".repeat(2300), location: { id: "1", name: "Konya" } },
      kinds,
      1,
    );
    expect(lines[0]).toMatchObject({ tone: "danger" });
    expect(lines[0]?.text).toMatch(/Instagram ilk yorumu en fazla 2.200 karakter/);
    expect(lines[1]).toEqual({
      tone: "warning",
      text: "Konum bu Facebook paylaşımında desteklenmiyor; bu hesaba gönderilmeyecek.",
    });
  });

  it("summarises the details in one line", () => {
    const fields = detailFields(publishKinds(content({ targetPlatforms: ["instagram"] }), 2));
    expect(detailsSummary(null, fields)).toBe("Eklenmedi");
    expect(
      detailsSummary(
        {
          firstComment: "x",
          altTexts: ["a", null],
          location: { id: "1", name: "Konya" },
          collaborators: ["o"],
          userTags: [{ slide: 0, username: "u", x: 0, y: 0 }],
        },
        fields,
      ),
    ).toBe("İlk yorum · 1 alternatif metin · Konum: Konya · 1 ortak hesap · 1 kişi etiketi");
  });
});

function detailsApi(c: Content) {
  return {
    contents: {
      setPublishDetails: vi.fn(async (_id: string, details: PublishDetails) => ({
        ...c,
        publishDetails: details,
      })),
    },
    publishLocations: {
      list: vi.fn(async () => ({
        items: [{ id: "998877", name: "MTM Agro Merkez", source: "page", lastUsedAt: null }],
      })),
      add: vi.fn(async () => ({ items: [] })),
    },
    assets: { list: vi.fn(async () => ({ items: [], nextCursor: null })) },
  };
}

describe("Yayın ayrıntıları section", () => {
  it("fills the alternative text, saves the first comment and the edited text", async () => {
    const c = contentFor(version("p1", 1), { status: "approved" });
    const api = detailsApi(c);
    const onSaved = vi.fn();
    wrap(
      <PublishDetailsSection
        content={c}
        slides={[slide({ html: SLIDE_HTML })]}
        onSaved={onSaved}
      />,
      api,
    );

    const alt = screen.getByRole("textbox", { name: "1. karenin alternatif metni" });
    expect(alt).toHaveValue(AUTO_TEXT);
    expect(screen.getByText(/Karedeki yazıdan dolduruldu/)).toBeInTheDocument();
    expect(screen.getByText("Kaydedilmedi")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "İlk yorum" }), "#hasat #toprak");
    expect(screen.getByText("14 / 2.200 karakter · 2/30 etiket")).toBeInTheDocument();
    await userEvent.clear(alt);
    await userEvent.type(alt, "Tarlada buğday");
    expect(screen.queryByText(/Karedeki yazıdan dolduruldu/)).not.toBeInTheDocument();

    // A collaborator with an @ and capitals.
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ortak hesap" }),
      "@Ortak.Marka{Enter}",
    );
    expect(screen.getByText("@ortak.marka")).toBeInTheDocument();
    // The brand's own Page as a location.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /MTM Agro Merkez/ })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Konum" }), "998877");

    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.contents.setPublishDetails).toHaveBeenCalledWith("p1", {
      firstComment: "#hasat #toprak",
      altTexts: ["Tarlada buğday"],
      altTextSources: ["manual"],
      location: { id: "998877", name: "MTM Agro Merkez" },
      collaborators: ["ortak.marka"],
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Yayın ayrıntıları kaydedildi.");
  });

  it("is read only once the post is published", () => {
    const c = contentFor(version("p1", 1), {
      status: "published",
      publishDetails: { firstComment: "#eski" },
    });
    wrap(<PublishDetailsSection content={c} slides={[slide()]} />, detailsApi(c));
    expect(screen.getByText(/artık değiştirilemez/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "İlk yorum" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "İlk yorum" })).toHaveValue("#eski");
    expect(screen.queryByRole("button", { name: "Kaydet" })).not.toBeInTheDocument();
  });

  it("shows nothing for a story; reels offer the cover and the feed switch", () => {
    const story = content({ type: "story" });
    const { container } = wrap(
      <PublishDetailsSection content={story} slides={[slide()]} />,
      detailsApi(story),
    );
    expect(container).toBeEmptyDOMElement();
    const reel = content({ type: "reel", targetPlatforms: ["instagram"] });
    wrap(<PublishDetailsSection content={reel} slides={[slide()]} />, detailsApi(reel));
    expect(screen.getByRole("radiogroup", { name: "Reels kapağı" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Akışta da göster" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: /alternatif metni/ })).not.toBeInTheDocument();
  });

  it("folds into a summary line in the schedule sheet", async () => {
    const c = contentFor(version("p1", 1), {
      publishDetails: { firstComment: "#hasat", location: { id: "1", name: "Konya" } },
    });
    wrap(
      <PublishDetailsSection content={c} slides={[]} collapsible defaultOpen={false} />,
      detailsApi(c),
    );
    const toggle = screen.getByRole("button", { name: /Yayın ayrıntıları/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("İlk yorum · Konum: Konya")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "İlk yorum" })).toHaveValue("#hasat");
  });
});

describe("Önerilen saatler", () => {
  const best: BestTimes = {
    basis: "own",
    sampleSize: 12,
    grid: Array.from({ length: 7 }, () => Array<number | null>(24).fill(null)),
    counts: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    suggestions: [
      { weekday: 1, hour: 19, score: 1.6, posts: 4 },
      { weekday: 4, hour: 12, score: 1.3, posts: 3 },
    ],
    note: "Son 180 günün 12 postuna göre (Türkiye saati).",
  };

  it("asks for the post's only Meta platform", () => {
    expect(bestTimesPlatform({ targetPlatforms: ["instagram", "linkedin"] })).toBe("instagram");
    expect(bestTimesPlatform({ targetPlatforms: ["instagram", "facebook"] })).toBeUndefined();
  });

  it("a click on a suggested slot sets the date and time", async () => {
    const v = version("p1", 1);
    const c = contentFor(v, { status: "approved" });
    const api = {
      ...detailsApi(c),
      contents: { ...detailsApi(c).contents, versions: { get: vi.fn(async () => v) } },
      schedules: { preflight: vi.fn(async () => preflight()) },
      insights: { bestTimes: vi.fn(async () => best) },
      publishing: { requestSync: vi.fn(async () => ({})) },
    };
    wrap(
      <ScheduleSheet
        open
        content={c}
        slideHtml={null}
        hash={null}
        accounts={[account()]}
        initialDate={new Date(Date.now() + 2 * 86_400_000)}
        onClose={() => undefined}
        onDone={() => undefined}
      />,
      api,
    );
    const chip = await screen.findByRole("button", { name: "Salı 19:00" });
    expect(screen.getByText(best.note)).toBeInTheDocument();
    expect(api.insights.bestTimes).toHaveBeenCalledWith("b1", { platform: "instagram" });
    await userEvent.click(chip);
    const expected = new Date(nextSlotTime({ weekday: 1, hour: 19 }));
    expect(screen.getByLabelText("Saat")).toHaveValue(timeInput(expected));
    expect(screen.getByLabelText("Saat")).toHaveValue("19:00");
    expect(screen.getByLabelText("Tarih")).toHaveValue(dateInput(expected));
    // The details sit folded under the accounts.
    expect(screen.getByRole("button", { name: /Yayın ayrıntıları/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

describe("statistics and comment permissions on accounts", () => {
  const ig = (over: Partial<SocialAccount> = {}) =>
    account({
      hasToken: true,
      tokenScopes: ["instagram_basic", "instagram_content_publish"],
      ...over,
    });

  it("asks for a reconnect when the token lacks them; unknown scopes stay quiet", () => {
    expect(engagementHint(ig())).toBe(ENGAGEMENT_RECONNECT_HINT);
    expect(
      engagementHint(
        ig({
          tokenScopes: [
            "instagram_basic",
            "instagram_content_publish",
            "instagram_manage_insights",
            "instagram_manage_comments",
          ],
        }),
      ),
    ).toBeNull();
    expect(engagementHint(ig({ tokenScopes: undefined }))).toBeNull();
    expect(
      engagementHint(ig({ platform: "linkedin", tokenScopes: ["w_member_social"] })),
    ).toBeNull();
    expect(engagementHint(ig({ status: "disabled" }))).toBeNull();
  });

  it("offers Yeniden bağla while publishing stays healthy", () => {
    const [row] = accountRows({
      brands: [
        {
          id: "b1",
          name: "MTM Agro",
          slug: "mtm",
          defaultLanguage: "tr",
          status: "active",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      accounts: [ig({ tokenHealth: "valid" })],
      apps: null,
    });
    expect(row).toMatchObject({
      kind: "account",
      action: "reconnect",
      engagementHint: ENGAGEMENT_RECONNECT_HINT,
      needsOwner: false,
    });
  });
});
