// Ayarlar in Claude's layout (⌘,): a rounded panel over the dimmed window: "Ayarlar" + ✕ on
// top, a sidebar (search + sections in groups) on the left, the section's rows on the right.
// Remembers the last section; deep links (`openSettings(section)`) pick one. The search
// filters rows across every section, table rows included. Esc clears the search, then closes;
// ✕ and a click on the dimmed window close it too.
import {
  Bell,
  CalendarClock,
  Gauge,
  Info,
  Link2,
  type LucideIcon,
  Palette,
  Settings2,
  Smartphone,
  Sparkles,
  Tag,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn, IconButton, SearchField } from "../../components/ui/controls.tsx";
import { IconClose } from "../../components/ui/icons.tsx";
import { usageMeters } from "../../lib/usage.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useAccounts, useBrands, useJobs, useSettings } from "../../state/studio.tsx";
import { AccountsSection } from "../accounts/accounts-section.tsx";
import { accountRows, flowBusy } from "../accounts/model.ts";
import { accountsBridge, usePublishingApps, useTokenWarnings } from "../accounts/use-accounts.ts";
import {
  ALL_ITEMS,
  escapeAction,
  initialSection,
  itemRow,
  type SearchRow,
  type SectionId,
  search,
  sectionGroups,
} from "./catalog.ts";
import {
  ConfirmContext,
  ConfirmDialog,
  type ConfirmRequest,
  type SettingsFilter,
  SettingsFilterContext,
  useHasRows,
} from "./parts.tsx";
import { AdvancedSection } from "./sections/advanced.tsx";
import { AiSection, UsageSection } from "./sections/ai.tsx";
import { BrandsSection, brandSearchText } from "./sections/brands.tsx";
import { DevicesSection, deviceSearchText, useDevices } from "./sections/devices.tsx";
import { AboutSection, AppearanceSection, NotificationsSection } from "./sections/general.tsx";
import { PublishingSection } from "./sections/publishing.tsx";
import { useSettingsSheet } from "./store.ts";

export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  ai: Sparkles,
  usage: Gauge,
  appearance: Palette,
  notifications: Bell,
  brands: Tag,
  accounts: Link2,
  publishing: CalendarClock,
  devices: Smartphone,
  advanced: Settings2,
  about: Info,
};

function SectionView({ id }: { id: SectionId }): ReactNode {
  switch (id) {
    case "ai":
      return <AiSection />;
    case "usage":
      return <UsageSection />;
    case "appearance":
      return <AppearanceSection />;
    case "notifications":
      return <NotificationsSection />;
    case "brands":
      return <BrandsSection />;
    case "accounts":
      return <AccountsSection />;
    case "publishing":
      return <PublishingSection />;
    case "devices":
      return <DevicesSection />;
    case "advanced":
      return <AdvancedSection />;
    case "about":
      return <AboutSection />;
  }
}

/** Table rows the sheet-wide search can find (brands, accounts, devices, usage windows). */
function useDynamicRows(): SearchRow[] {
  const brands = useBrands();
  const accounts = useAccounts();
  const apps = usePublishingApps();
  const devices = useDevices();
  const { presence } = useJobs();
  return useMemo(() => {
    const rows: SearchRow[] = [];
    for (const brand of brands.data ?? []) {
      rows.push({ id: `brand:${brand.id}`, section: "brands", text: brandSearchText(brand) });
    }
    for (const row of accountRows({
      brands: brands.data ?? [],
      accounts: accounts.data ?? [],
      apps: apps.data,
    })) {
      rows.push({ id: row.id, section: "accounts", text: row.searchText });
    }
    for (const device of devices.data ?? []) {
      if (device.revokedAt === null) {
        rows.push({
          id: `device:${device.id}`,
          section: "devices",
          text: deviceSearchText(device),
        });
      }
    }
    for (const meter of usageMeters(presence?.usage)) {
      rows.push({
        id: `usage.claude.${meter.kind}`,
        section: "usage",
        text: `${meter.title} kullanım claude limit`,
      });
    }
    return rows;
  }, [brands.data, accounts.data, apps.data, devices.data, presence?.usage]);
}

export function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen);
  // Accounts that must be reconnected get a macOS notice even while Ayarlar is closed.
  useTokenWarnings(useAccounts().data);
  if (!open) return null;
  return <SettingsPanel />;
}

function SettingsPanel() {
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const { settings, update } = useSettings();
  const requestId = useSettingsSheet((s) => s.requestId);
  const [section, setSection] = useState<SectionId>(() =>
    initialSection(useSettingsSheet.getState().requested, settings.settingsSection),
  );
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const remembered = useRef(settings.settingsSection);
  remembered.current = settings.settingsSection;

  const select = useCallback(
    (id: SectionId) => {
      setQuery("");
      setSection(id);
      if (id !== remembered.current) update({ settingsSection: id });
      if (contentRef.current) contentRef.current.scrollTop = 0;
    },
    [update],
  );

  // Deep links: on open (the requested section becomes the remembered one) and while open.
  useEffect(() => {
    const { requested } = useSettingsSheet.getState();
    if (requested) {
      select(requested);
      useSettingsSheet.setState({ requested: null });
    }
  }, [requestId]);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  // A connect flow waiting on the browser stops with the sheet (the loopback port is freed).
  useEffect(
    () => () => {
      const accounts = accountsBridge();
      void accounts.state().then((state) => {
        if (flowBusy(state.phase)) void accounts.cancel();
      });
    },
    [],
  );

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        // An open menu (model, "+ Hesap ekle", "…") closes first, even when its trigger
        // kept the keyboard focus.
        const menu = document.querySelector<HTMLElement>("[data-studio-menu]");
        if (menu) {
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return;
        }
        if (escapeAction(queryRef.current) === "clear") setQuery("");
        else close();
        return;
      }
      if (event.metaKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const dynamicRows = useDynamicRows();
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? search(query, [...ALL_ITEMS.map(itemRow), ...dynamicRows]) : []),
    [searching, query, dynamicRows],
  );
  const filter = useMemo<SettingsFilter>(() => {
    if (!searching) return { searching: false, visible: () => true };
    const ids = new Set(results.flatMap((r) => r.ids));
    return { searching: true, visible: (id) => ids.has(id) };
  }, [searching, results]);
  const hasRows = useHasRows(contentRef, searching);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the dimmed window closes (Esc does too)
    <div
      className="fixed inset-0 z-[96] flex items-center justify-center bg-black/40 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ayarlar"
        className="relative flex animate-pop-in flex-col overflow-hidden rounded-[14px] border border-border bg-surface-2 shadow-popover"
        style={{
          width: "clamp(680px, calc(100vw - 120px), 1020px)",
          height: "clamp(480px, calc(100vh - 80px), 800px)",
        }}
      >
        <header className="flex h-[52px] shrink-0 items-center border-b border-hairline pr-3 pl-5">
          <h2 className="flex-1 text-prose font-semibold text-fg">Ayarlar</h2>
          <IconButton icon={<IconClose size={16} />} label="Kapat" shortcut="Esc" onClick={close} />
        </header>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Ayarlar bölümleri"
            className="scroll-area flex w-[212px] shrink-0 flex-col gap-2 border-r border-hairline p-3"
          >
            <SearchField
              ref={searchRef}
              className="w-full shrink-0"
              placeholder="Ara"
              aria-label="Ayarlarda ara"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {sectionGroups().map((group, index, all) => (
              <div
                key={group[0]?.id}
                className={cn(
                  "flex flex-col",
                  index < all.length - 1 && "border-b border-hairline pb-2",
                )}
              >
                {group.map((s) => {
                  const Icon = SECTION_ICONS[s.id];
                  const selected = !searching && s.id === section;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      data-selected={selected || undefined}
                      onClick={() => select(s.id)}
                      className={cn(
                        "flex h-8 shrink-0 items-center gap-2.5 rounded-full px-2.5 text-left text-body text-fg",
                        "transition-colors duration-150 hover:bg-control data-[selected]:bg-selected",
                      )}
                    >
                      <Icon size={16} strokeWidth={1.5} className="shrink-0 text-icon" />
                      <span className="truncate">{s.title}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <ConfirmContext.Provider value={setConfirm}>
            <SettingsFilterContext.Provider value={filter}>
              <div
                ref={contentRef}
                data-testid="settings-content"
                className="scroll-area min-w-0 flex-1 px-6 pt-[18px] pb-8"
              >
                {searching ? (
                  <div className="flex flex-col gap-9">
                    {results.map((r) => (
                      <SectionView key={r.section} id={r.section} />
                    ))}
                    {(results.length === 0 || !hasRows) && (
                      <p className="pt-2 text-body-lg text-fg-2">Sonuç yok</p>
                    )}
                  </div>
                ) : (
                  <SectionView key={section} id={section} />
                )}
              </div>
            </SettingsFilterContext.Provider>
          </ConfirmContext.Provider>
        </div>
        <ConfirmDialog request={confirm} onClose={closeConfirm} />
      </div>
    </div>
  );
}
