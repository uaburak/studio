import { useQuery } from "@tanstack/react-query";
import type { ComponentType, SVGProps } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useApi } from "../../api.ts";
import {
  IconBrands,
  IconCalendar,
  IconChevronDown,
  IconContents,
  IconJobs,
  IconMedia,
  IconMonitor,
  IconMoon,
  IconSun,
} from "../../components/icons.tsx";
import { BrandMark } from "../../components/page.tsx";
import { cx } from "../../components/ui.tsx";
import { describeHealth } from "../../health-view.ts";
import { useBrands } from "../../lib/brand-context.tsx";
import { queryKeys } from "../../lib/query-keys.ts";
import { type ThemePreference, useTheme } from "../../lib/theme.tsx";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/icerikler", label: "İçerikler", icon: IconContents },
  { to: "/takvim", label: "Takvim", icon: IconCalendar },
  { to: "/medya", label: "Medya", icon: IconMedia },
  { to: "/isler", label: "İşler", icon: IconJobs },
  { to: "/markalar", label: "Markalar", icon: IconBrands },
];

export function AppShell() {
  const location = useLocation();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-ink px-3 py-2 text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line px-4 py-6 lg:flex">
        <Wordmark />
        <BrandSwitcher />
        <nav aria-label="Ana menü" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  "group flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition-colors",
                  isActive
                    ? "bg-surface text-ink shadow-card ring-1 ring-line/70"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={isActive ? "text-accent" : "text-ink-3 group-hover:text-ink-2"}
                  />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3">
          <ThemeToggle />
          <HealthDot />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="pt-safe sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Wordmark compact />
          <div className="min-w-0 flex-1">
            <BrandSwitcher compact />
          </div>
          <ThemeCycleButton />
        </div>
      </header>

      <main
        id="main"
        key={location.pathname.split("/")[1]}
        className="min-w-0 px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-16"
      >
        <div className="mx-auto max-w-[1240px]">
          <Outlet />
        </div>
      </main>

      {/* Mobile tab bar */}
      <nav
        aria-label="Ana menü"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 backdrop-blur-md lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cx(
                    "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                    isActive ? "text-ink" : "text-ink-3",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={22} className={isActive ? "text-accent" : undefined} />
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <NavLink
      to="/"
      className="flex items-baseline gap-1.5 px-1 text-ink"
      aria-label="Studio ana sayfa"
    >
      <span className={cx("font-display leading-none", compact ? "text-[26px]" : "text-[34px]")}>
        Studio
      </span>
      <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
    </NavLink>
  );
}

/**
 * Persistent brand switcher. A native <select> sits invisibly on top of the
 * styled face, so keyboard, screen readers and the iOS picker all work.
 */
export function BrandSwitcher({ compact }: { compact?: boolean }) {
  const { brandId, brand, setBrandId, activeBrands, brands } = useBrands();
  const archivedSelected = brand && brand.status === "archived";
  return (
    <div
      className={cx(
        "relative flex items-center gap-2.5 rounded-xl bg-surface ring-1 ring-line has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
        compact ? "h-10 px-2" : "h-14 px-3 shadow-card",
      )}
    >
      {brand ? (
        <BrandMark id={brand.id} name={brand.name} size={compact ? 26 : 32} />
      ) : (
        <span
          aria-hidden="true"
          className={cx(
            "grid shrink-0 grid-cols-2 gap-0.5 rounded-[30%] bg-surface-2 p-1.5",
            compact ? "size-[26px] p-1" : "size-8",
          )}
        >
          <span className="rounded-full bg-accent" />
          <span className="rounded-full bg-info" />
          <span className="rounded-full bg-good" />
          <span className="rounded-full bg-warn" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        {!compact && (
          <span className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Marka</span>
        )}
        <span className="truncate text-[14px] font-medium text-ink">
          {brand ? brand.name : "Tüm markalar"}
        </span>
      </span>
      <IconChevronDown size={16} className="shrink-0 text-ink-3" />
      <select
        aria-label="Marka seç"
        value={brandId ?? ""}
        onChange={(e) => setBrandId(e.target.value || null)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Tüm markalar</option>
        {activeBrands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        {archivedSelected && <option value={brand.id}>{brand.name} (arşivde)</option>}
        {brands.length === 0 && (
          <option value="" disabled>
            Henüz marka yok
          </option>
        )}
      </select>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
  { value: "light", label: "Açık", icon: IconSun },
  { value: "dark", label: "Koyu", icon: IconMoon },
  { value: "system", label: "Sistem", icon: IconMonitor },
];

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset>
      <legend className="sr-only">Tema</legend>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
        {THEME_OPTIONS.map((o) => (
          <label
            key={o.value}
            title={o.label}
            className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium text-ink-3 has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
          >
            <input
              type="radio"
              name="theme"
              value={o.value}
              aria-label={`Tema: ${o.label}`}
              className="sr-only"
              checked={preference === o.value}
              onChange={() => setPreference(o.value)}
            />
            <o.icon size={15} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ThemeCycleButton() {
  const { preference, setPreference } = useTheme();
  const index = THEME_OPTIONS.findIndex((o) => o.value === preference);
  const current = THEME_OPTIONS[index] ?? THEME_OPTIONS[2];
  const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length] ?? THEME_OPTIONS[0];
  if (!current || !next) return null;
  return (
    <button
      type="button"
      onClick={() => setPreference(next.value)}
      aria-label={`Tema: ${current.label}. ${next.label} temaya geç`}
      className="inline-flex size-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2"
    >
      <current.icon />
    </button>
  );
}

function HealthDot() {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.health({ signal }),
    refetchInterval: 30_000,
    retry: false,
  });
  const view = describeHealth(
    query.isPending
      ? { kind: "loading" }
      : query.error
        ? { kind: "error", message: query.error.message }
        : { kind: "ok", data: query.data as NonNullable<typeof query.data> },
  );
  const color = { neutral: "bg-ink-3", good: "bg-good", warn: "bg-warn", bad: "bg-bad" }[view.tone];
  return (
    <div
      className="flex items-center gap-2 px-1 text-[12px] text-ink-3"
      title={view.detail}
      role="status"
    >
      <span className={cx("size-2 rounded-full", color)} aria-hidden="true" />
      {view.title}
    </div>
  );
}
