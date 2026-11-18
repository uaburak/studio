import type { ApiClient, Brand, SocialAccount } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountsBridge,
  AccountsState,
  PublishingApps,
} from "../../src/shared/accounts-ipc.ts";
import type { DesktopSettings, HostSnapshot } from "../../src/shared/ipc.ts";

// --- studio.tsx stand-in: settings, host, server data -------------------------------------------------

const T = "2026-11-17T10:00:00.000Z";

const state = vi.hoisted(() => ({
  settings: null as unknown as DesktopSettings,
  update: (() => undefined) as (patch: Partial<DesktopSettings>) => void,
  brands: [] as Brand[],
  accounts: [] as SocialAccount[],
}));

vi.mock("../../src/renderer/state/studio.tsx", () => {
  const host: HostSnapshot = {
    status: { kind: "attached" },
    apiPort: 8790,
    lanPort: 8791,
    instance: "i",
    lanUrls: ["http://192.168.1.5:8791"],
    tunnelUrl: null,
    tunnelNote: null,
    services: {},
    ownsChildren: false,
  };
  return {
    queryKeys: { brands: ["brands"], conversations: ["conversations"], accounts: ["accounts"] },
    isHostUp: () => true,
    useHost: () => host,
    useSettings: () => ({ settings: state.settings, update: state.update }),
    useJobs: () => ({ jobs: [], presence: null, status: "open" }),
    useBrands: () => ({ data: state.brands, isSuccess: true, isLoading: false }),
    useAccounts: () => ({ data: state.accounts, isSuccess: true, isError: false }),
  };
});

import {
  AccountsSection,
  MetaPicker,
} from "../../src/renderer/features/accounts/accounts-section.tsx";
import { accountRows, flowBusy, tokenNotices } from "../../src/renderer/features/accounts/model.ts";
import {
  ALL_ITEMS,
  escapeAction,
  initialSection,
  itemRow,
  matches,
  normalize,
  search,
  sectionGroups,
} from "../../src/renderer/features/settings/catalog.ts";
import { SettingsSheet } from "../../src/renderer/features/settings/settings-sheet.tsx";
import { openSettings } from "../../src/renderer/features/settings/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import {
  createFallbackBridge,
  fallbackSettings,
  setBridge,
} from "../../src/renderer/lib/bridge.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";

function brand(over: Partial<Brand> = {}): Brand {
  return {
    id: "b1",
    name: "MTM Agro",
    slug: "mtm-agro",
    defaultLanguage: "tr",
    status: "active",
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function account(over: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "a1",
    brandId: "b1",
    platform: "instagram",
    handle: "mtmagro",
    externalId: "ig1",
    status: "connected",
    createdAt: T,
    updatedAt: T,
    hasToken: true,
    tokenHealth: "valid",
    tokenExpiresAt: null,
    ...over,
  };
}

const APPS: PublishingApps = {
  meta: { appId: "123", hasSecret: true },
  linkedIn: { clientId: "", hasSecret: false },
};

function fakeAccountsBridge(initial: AccountsState["phase"] = { kind: "idle" }) {
  let current: AccountsState = { phase: initial, busyAccountIds: [], revision: 0 };
  const listeners = new Set<(s: AccountsState) => void>();
  const bridge = {
    state: vi.fn(async () => current),
    onChange: vi.fn((l: (s: AccountsState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    apps: vi.fn(async () => APPS),
    saveMetaApp: vi.fn(async () => ({ ok: true as const, value: APPS })),
    saveLinkedInApp: vi.fn(async () => ({ ok: true as const, value: APPS })),
    forgetMetaSecret: vi.fn(async () => APPS),
    connectMeta: vi.fn(async () => undefined),
    connectLinkedIn: vi.fn(async () => undefined),
    confirmMeta: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  } satisfies AccountsBridge;
  return {
    bridge,
    emit(next: Partial<AccountsState>) {
      current = { ...current, ...next };
      for (const l of listeners) l(current);
    },
  };
}

const api = {
  workers: {
    claude: async () => ({ account: null, online: false, sent: 0 }),
    gemini: async () => ({ account: null, online: false, sent: 0 }),
  },
  publishing: {
    status: async () => ({
      mode: "local",
      cloud: {
        configured: false,
        url: null,
        lastSyncAt: null,
        lastSyncOk: null,
        lastSyncError: null,
        syncRequestedAt: null,
      },
      vaultReady: true,
    }),
  },
  devices: { list: async () => ({ items: [] }) },
} as unknown as ApiClient;

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </ApiContext.Provider>,
  );
}

let accounts: ReturnType<typeof fakeAccountsBridge>;

beforeEach(() => {
  state.settings = { ...fallbackSettings(), settingsSection: "" };
  state.update = vi.fn((patch) => {
    state.settings = { ...state.settings, ...patch } as DesktopSettings;
  });
  state.brands = [brand(), brand({ id: "b2", name: "Partner Agro", slug: "partner-agro" })];
  state.accounts = [account()];
  accounts = fakeAccountsBridge();
  setBridge({ ...createFallbackBridge(), accounts: accounts.bridge });
  useAppStore.setState({ settingsOpen: false });
});

afterEach(() => {
  setBridge(undefined);
});

// --- catalog: search, section memory, Esc ---------------------------------------------------------------

describe("settings catalog", () => {
  it("groups sections like the AppKit sidebar", () => {
    expect(sectionGroups().map((g) => g.map((s) => s.title))).toEqual([
      ["Yapay zekâ", "Kullanım"],
      ["Görünüm", "Bildirimler"],
      ["Markalar", "Hesaplar", "Yayın"],
      ["Cihazlar", "Gelişmiş", "Hakkında"],
    ]);
  });

  it("folds Turkish letters and accents; every word must match", () => {
    expect(normalize("Görünüm İŞ zekâ")).toBe("gorunum is zeka");
    expect(matches("gorunum", "Görünüm")).toBe(true);
    expect(matches("zeka", "Yapay zekâ")).toBe(true);
    expect(matches("tünel anahtar", "Tünel adresi ve anahtarı")).toBe(true);
    expect(matches("tünel kod", "Tünel adresi ve anahtarı")).toBe(false);
    expect(matches("", "anything")).toBe(true);
  });

  it("finds rows across sections, by their own words or their section's, plus table rows", () => {
    const rows = [
      ...ALL_ITEMS.map(itemRow),
      {
        id: "brand:b2",
        section: "brands" as const,
        text: "Partner Agro partner-agro Türkçe marka",
      },
      {
        id: "account:a1",
        section: "accounts" as const,
        text: "@mtmagro Instagram MTM Agro Bağlı hesap",
      },
    ];
    expect(search("", rows)).toEqual([]);
    expect(search("selam", rows)).toEqual([{ section: "appearance", ids: ["appearance.name"] }]);
    // "tema" is one of Görünüm's own words: the whole section shows.
    expect(search("tema", rows)).toEqual([
      { section: "appearance", ids: ["appearance.theme", "appearance.name"] },
    ]);
    // "anahtar" hits the AI (Gemini API key), accounts, advanced rows; in sidebar order.
    expect(search("anahtar", rows).map((r) => r.section)).toEqual(["ai", "accounts", "advanced"]);
    // A section's own words show every row of it.
    expect(search("bildirim", rows)).toEqual([
      { section: "notifications", ids: ["notifications.enabled"] },
    ]);
    expect(search("partner", rows)).toEqual([{ section: "brands", ids: ["brand:b2"] }]);
    expect(search("mtmagro", rows)).toEqual([{ section: "accounts", ids: ["account:a1"] }]);
  });

  it("opens a deep link's section, else the remembered one, else Markalar", () => {
    expect(initialSection("accounts", "ai")).toBe("accounts");
    expect(initialSection(null, "ai")).toBe("ai");
    expect(initialSection(null, "nope")).toBe("brands");
    expect(initialSection(null, "")).toBe("brands");
  });

  it("Esc clears a search first, then closes", () => {
    expect(escapeAction("tema")).toBe("clear");
    expect(escapeAction("")).toBe("close");
  });
});

// --- the sheet --------------------------------------------------------------------------------------------

describe("SettingsSheet", () => {
  it("opens with ⌘, state at the remembered section and remembers a new one", async () => {
    state.settings = { ...state.settings, settingsSection: "appearance" };
    useAppStore.setState({ settingsOpen: true });
    wrap(<SettingsSheet />);
    const dialog = screen.getByRole("dialog", { name: "Ayarlar" });
    expect(within(dialog).getByRole("button", { name: "Görünüm" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dialog).getByText("Tema")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Bildirimler" }));
    expect(state.update).toHaveBeenCalledWith({ settingsSection: "notifications" });
    expect(within(dialog).getByText("macOS bildirimleri")).toBeInTheDocument();
    expect(within(dialog).queryByText("Tema")).not.toBeInTheDocument();
  });

  it("a deep link picks the section and becomes the remembered one", () => {
    state.settings = { ...state.settings, settingsSection: "ai" };
    act(() => openSettings("about"));
    wrap(<SettingsSheet />);
    expect(screen.getByRole("button", { name: "Hakkında" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(state.update).toHaveBeenCalledWith({ settingsSection: "about" });
  });

  it("searches across sections and table rows; Esc clears, then closes", async () => {
    useAppStore.setState({ settingsOpen: true });
    wrap(<SettingsSheet />);
    const field = screen.getByRole("searchbox", { name: "Ayarlarda ara" });
    await userEvent.type(field, "selam");
    expect(screen.getByText("Adın")).toBeInTheDocument();
    expect(screen.queryByText("Tema")).not.toBeInTheDocument();
    // No section is selected while results show.
    expect(screen.getByRole("button", { name: "Görünüm" })).not.toHaveAttribute("aria-current");

    await userEvent.clear(field);
    await userEvent.type(field, "partner");
    expect((await screen.findAllByText("Partner Agro")).length).toBeGreaterThan(0);
    expect(screen.queryByText("MTM Agro")).not.toBeInTheDocument();

    await userEvent.clear(field);
    await userEvent.type(field, "zzzz");
    expect(screen.getByText("Sonuç yok")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(field).toHaveValue("");
    expect(useAppStore.getState().settingsOpen).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it("✕ and a click on the dimmed window close it", async () => {
    useAppStore.setState({ settingsOpen: true });
    const { unmount } = wrap(<SettingsSheet />);
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(useAppStore.getState().settingsOpen).toBe(false);
    unmount();
    useAppStore.setState({ settingsOpen: true });
    wrap(<SettingsSheet />);
    const dialog = screen.getByRole("dialog", { name: "Ayarlar" });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it("cancels a connect flow that waits on the browser when it closes", async () => {
    accounts = fakeAccountsBridge({ kind: "waiting", platform: "meta", brandId: "b1" });
    setBridge({ ...createFallbackBridge(), accounts: accounts.bridge });
    useAppStore.setState({ settingsOpen: true });
    const { unmount } = wrap(<SettingsSheet />);
    unmount();
    await vi.waitFor(() => expect(accounts.bridge.cancel).toHaveBeenCalled());
  });
});

// --- accounts table -----------------------------------------------------------------------------------------

describe("accounts table", () => {
  const now = new Date(T);

  it("one row per account plus Bağla rows for missing platforms", () => {
    const rows = accountRows({
      brands: [brand(), brand({ id: "bx", name: "Eski", status: "archived" })],
      accounts: [
        account(),
        account({ id: "a2", platform: "facebook", handle: "MTM", status: "needs_reauth" }),
        account({ id: "a3", platform: "linkedin", handle: "Burak", status: "disabled" }),
      ],
      apps: APPS,
      busyIds: ["a1"],
      now,
    });
    expect(rows.map((r) => [r.id, r.kind === "account" ? r.action : r.status])).toEqual([
      ["account:a1", "none"],
      ["account:a2", "reconnect"],
      ["account:a3", "connect"],
      // The disabled LinkedIn account still leaves the platform to connect; no Meta app → LinkedIn needs one.
      ["missing:b1:linkedin", "Uygulama gerekli"],
    ]);
    const [ig, fb, li] = rows;
    expect(ig).toMatchObject({ title: "@mtmagro", status: "Geçerli", healthy: true, busy: true });
    expect(fb).toMatchObject({ status: "Yeniden bağlanmalı", needsOwner: true, configured: true });
    expect(li).toMatchObject({ status: "Bağlantı kesildi", dimmed: true, configured: false });
  });

  it("days left and expiring tokens turn the row orange", () => {
    const [row] = accountRows({
      brands: [brand()],
      accounts: [account({ tokenExpiresAt: "2026-11-20T10:00:00.000Z" })],
      apps: APPS,
      now,
    });
    expect(row).toMatchObject({ status: "Geçerli · 3 gün kaldı", needsOwner: true });
  });

  it("warns about invalid and expiring tokens once per account and day", () => {
    const notices = tokenNotices(
      [
        account(),
        account({ id: "a2", platform: "facebook", handle: "MTM", status: "needs_reauth" }),
        account({
          id: "a3",
          platform: "linkedin",
          handle: "Burak",
          tokenExpiresAt: "2026-11-19T09:00:00.000Z",
        }),
        account({ id: "a4", status: "disabled", tokenHealth: "invalid" }),
      ],
      now,
    );
    expect(notices).toEqual([
      {
        id: "token:a2:invalid:20774",
        title: "Hesap yeniden bağlanmalı",
        body: "Facebook · MTM: erişim anahtarı geçersiz. Ayarlar → Hesaplar'dan yeniden bağlayın.",
        route: "settings:accounts",
      },
      {
        id: "token:a3:expiring:20774",
        title: "Hesap bağlantısı yakında doluyor",
        body: "LinkedIn · Burak: 2 gün içinde yeniden bağlanmalı.",
        route: "settings:accounts",
      },
    ]);
  });

  it("renders states, Bağla / Yeniden bağla and the disconnect confirmation", async () => {
    state.accounts = [
      account(),
      account({ id: "a2", platform: "facebook", handle: "MTM Sayfa", status: "needs_reauth" }),
    ];
    useAppStore.setState({ settingsOpen: true });
    state.settings = { ...state.settings, settingsSection: "accounts" };
    wrap(<SettingsSheet />);
    const table = await screen.findByRole("table", { name: "Hesaplar" });
    await vi.waitFor(() =>
      expect(within(table).getAllByRole("button", { name: /bağla$/ }).length).toBeGreaterThan(0),
    );
    expect(within(table).getByText("@mtmagro")).toBeInTheDocument();
    expect(within(table).getByText("Geçerli")).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "Yeniden bağla" }));
    expect(accounts.bridge.connectMeta).toHaveBeenCalledWith("b1");
    // LinkedIn without its app: Bağla is disabled.
    expect(
      within(table).getByRole("button", { name: "LinkedIn · MTM Agro: bağla" }),
    ).toBeDisabled();
    await userEvent.click(
      within(table).getByRole("button", { name: "Instagram · Partner Agro: bağla" }),
    );
    expect(accounts.bridge.connectMeta).toHaveBeenCalledWith("b2");

    await userEvent.click(within(table).getByRole("button", { name: "@mtmagro: seçenekler" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Bağlantıyı kes…" }));
    const alert = screen.getByRole("alertdialog");
    expect(alert).toHaveTextContent("@mtmagro bağlantısı kesilsin mi?");
    // Esc closes the alert, not the sheet.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(true);
    await userEvent.click(within(table).getByRole("button", { name: "@mtmagro: seçenekler" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Bağlantıyı kes…" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Bağlantıyı kes" }),
    );
    expect(accounts.bridge.disconnect).toHaveBeenCalledWith("a1");
  });

  it("shows the flow: waiting line with Vazgeç, then the result", async () => {
    accounts = fakeAccountsBridge({ kind: "waiting", platform: "linkedin", brandId: "b1" });
    setBridge({ ...createFallbackBridge(), accounts: accounts.bridge });
    wrap(<AccountsSection />);
    expect(await screen.findByText(/Tarayıcıda LinkedIn girişi bekleniyor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hesap ekle" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(accounts.bridge.cancel).toHaveBeenCalled();
    act(() => accounts.emit({ phase: { kind: "failed", message: "Port dolu." }, revision: 1 }));
    expect(screen.getByText("Port dolu.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(accounts.bridge.dismiss).toHaveBeenCalled();
    expect(
      flowBusy({
        kind: "picking",
        brandId: "b",
        pages: [],
        missingScopes: [],
        longLived: true,
        initial: [],
      }),
    ).toBe(true);
  });

  it("the Meta picker sends the picked Pages", async () => {
    render(
      <MetaPicker
        brandName="MTM Agro"
        phase={{
          kind: "picking",
          brandId: "b1",
          pages: [
            {
              pageId: "p1",
              pageName: "MTM Agro",
              canPublish: true,
              instagram: { igUserId: "ig1", username: "mtmagro" },
            },
            { pageId: "p2", pageName: "Yetkisiz", canPublish: false, instagram: null },
          ],
          missingScopes: ["pages_manage_posts"],
          longLived: true,
          initial: [{ pageId: "p1", facebook: false, instagram: true }],
        }}
      />,
    );
    expect(screen.getByText(/Verilmeyen izinler: pages_manage_posts/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Facebook Sayfası · Yetkisiz/ })).toBeDisabled();
    const connect = screen.getByRole("button", { name: "Seçilenleri bağla (1)" });
    await userEvent.click(screen.getByRole("checkbox", { name: /Facebook Sayfası · MTM Agro/ }));
    await userEvent.click(screen.getByRole("button", { name: "Seçilenleri bağla (2)" }));
    expect(accounts.bridge.confirmMeta).toHaveBeenCalledWith([
      { pageId: "p1", facebook: true, instagram: true },
    ]);
    expect(connect).toBeInTheDocument();
  });

  it("app secrets go to the main process once and leave the field", async () => {
    wrap(<AccountsSection />);
    await userEvent.click(screen.getByRole("radio", { name: "Uygulamalar" }));
    const secret = await screen.findByLabelText("Meta App Secret");
    await userEvent.type(secret, "TOPSECRET");
    const saves = screen.getAllByRole("button", { name: "Kaydet" });
    await userEvent.click(saves[0] as HTMLElement);
    expect(accounts.bridge.saveMetaApp).toHaveBeenCalledWith({ appId: "123", secret: "TOPSECRET" });
    await vi.waitFor(() => expect(secret).toHaveValue(""));
    expect(await screen.findByText("Kaydedildi.")).toBeInTheDocument();
  });
});
