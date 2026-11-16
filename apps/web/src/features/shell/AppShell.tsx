import { useQuery } from "@tanstack/react-query";
import { type ComponentType, type SVGProps, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import {
  IconBrands,
  IconCalendar,
  IconChat,
  IconChevronDown,
  IconContents,
  IconJobs,
  IconMedia,
  IconMonitor,
  IconMoon,
  IconRefresh,
  IconSun,
} from "../../components/icons.tsx";
import { BrandMark } from "../../components/page.tsx";
import { Badge, Button, cx, KeyValue, Mono, Progress } from "../../components/ui.tsx";
import { describeHealth } from "../../health-view.ts";
import { useBrands } from "../../lib/brand-context.tsx";
import { formatDateTime } from "../../lib/datetime.ts";
import { formatPercent } from "../../lib/format.ts";
import { JOB_TYPE_LABELS } from "../../lib/labels.ts";
import { CancelJobButton, useLiveJobs } from "../../lib/live-jobs.tsx";
import { queryKeys } from "../../lib/query-keys.ts";
import { type ThemePreference, useTheme } from "../../lib/theme.tsx";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/chat", label: "Sohbet", icon: IconChat },
  { to: "/icerikler", label: "İçerikler", icon: IconContents },
  { to: "/takvim", label: "Takvim", icon: IconCalendar },
  { to: "/medya", label: "Medya", icon: IconMedia },
  { to: "/isler", label: "İşler", icon: IconJobs },
  { to: "/markalar", label: "Markalar", icon: IconBrands },
];

export function AppShell() {
  const location = useLocation();
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-ink px-3 py-2 text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-5 border-r border-line px-4 py-6 lg:flex">
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
          <WorkerStatusCard onOpenDetails={() => setStatusOpen(true)} />
          <ThemeToggle />
          <HealthDot />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="pt-safe sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md lg:hidden">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Wordmark compact />
          <div className="min-w-0 flex-1">
            <BrandSwitcher compact />
          </div>
          <WorkerStatusPill onClick={() => setStatusOpen(true)} />
          <ThemeCycleButton />
        </div>
      </header>

      <main
        id="main"
        key={location.pathname.split("/")[1]}
        className="min-w-0 px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-8 lg:pb-16"
      >
        <div className="mx-auto max-w-[1240px]">
          <LiveJobTopBar onOpenDetails={() => setStatusOpen(true)} />
          <Outlet />
        </div>
      </main>

      {/* Mobile tab bar */}
      <nav
        aria-label="Ana menü"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 backdrop-blur-md lg:hidden"
      >
        <ul className="grid grid-cols-6">
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
                    <item.icon size={20} className={isActive ? "text-accent" : undefined} />
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <AiStatusDialog open={statusOpen} onClose={() => setStatusOpen(false)} />
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

function WorkerStatusCard({ onOpenDetails }: { onOpenDetails: () => void }) {
  const { presence, summary, streamStatus } = useLiveJobs();
  const dotColor =
    summary.macTone === "good" ? "bg-good" : summary.macTone === "warn" ? "bg-warn" : "bg-ink-3";

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      aria-label={`Mac ve AI durumu: ${summary.macLabel}`}
      className="flex flex-col gap-2 rounded-xl bg-surface p-3 text-left ring-1 ring-line transition-colors hover:bg-surface-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <span className={cx("size-2 rounded-full", dotColor)} aria-hidden="true" />
          {summary.macLabel}
        </span>
        <span className="font-mono text-[10px] tracking-wide text-ink-3 uppercase">
          {streamStatus === "open" ? "canlı" : "yoklama"}
        </span>
      </div>
      {presence && (
        <div className="flex flex-wrap gap-1">
          <Badge tone={summary.claudeTone} dot={false} className="h-5 px-2 text-[11px]">
            {summary.claudeLabel}
          </Badge>
          <Badge tone={summary.geminiTone} dot={false} className="h-5 px-2 text-[11px]">
            {summary.geminiLabel}
          </Badge>
        </div>
      )}
      <p className="truncate text-[11px] text-ink-3">{summary.macDetail}</p>
    </button>
  );
}

function WorkerStatusPill({ onClick }: { onClick: () => void }) {
  const { presence, summary } = useLiveJobs();
  if (!presence) return null;
  const dotColor = summary.macTone === "good" ? "bg-good" : "bg-warn";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={summary.macLabel}
      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-surface px-2.5 text-[12px] font-medium text-ink ring-1 ring-line"
    >
      <span className={cx("size-2 rounded-full", dotColor)} aria-hidden="true" />
      <span className="hidden sm:inline">{summary.macLabel}</span>
    </button>
  );
}

/** Real-time status & active job progress strip shown across views when live data is active. */
function LiveJobTopBar({ onOpenDetails }: { onOpenDetails: () => void }) {
  const { presence, summary, activeJobs } = useLiveJobs();
  const runningJob = activeJobs.find((j) => j.status === "running") ?? activeJobs[0];

  if (!presence && !runningJob) return null;

  return (
    <section
      aria-label="Canlı sistem ve iş durumu"
      className="mb-5 flex flex-col gap-2.5 rounded-2xl bg-surface px-4 py-2.5 shadow-card ring-1 ring-line/70 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <button
          type="button"
          onClick={onOpenDetails}
          className="inline-flex items-center gap-1.5 font-medium text-ink hover:text-accent"
        >
          <span
            className={cx(
              "size-2 rounded-full",
              summary.macTone === "good"
                ? "bg-good"
                : summary.macTone === "warn"
                  ? "bg-warn"
                  : "bg-ink-3",
            )}
            aria-hidden="true"
          />
          {summary.macLabel}
        </button>
        {presence && (
          <>
            <span className="text-line-strong">·</span>
            <Badge tone={summary.claudeTone} dot={false}>
              {summary.claudeLabel}
            </Badge>
            <Badge tone={summary.geminiTone} dot={false}>
              {summary.geminiLabel}
            </Badge>
          </>
        )}
      </div>

      {runningJob && (
        <div className="flex flex-wrap items-center gap-3 sm:min-w-72 sm:justify-end">
          <Link
            to={`/isler/${runningJob.id}`}
            className="min-w-0 flex-1 hover:opacity-85 sm:max-w-xs"
          >
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate font-medium text-ink">
                {runningJob.progressMessage || JOB_TYPE_LABELS[runningJob.type]}
              </span>
              {runningJob.progress !== undefined && (
                <span className="font-mono text-ink-2 tabular-nums">
                  {formatPercent(runningJob.progress)}
                </span>
              )}
            </div>
            {runningJob.progress !== undefined && (
              <div className="mt-1">
                <Progress value={runningJob.progress} label="Aktif iş ilerlemesi" />
              </div>
            )}
          </Link>
          <CancelJobButton job={runningJob} size="sm" />
        </div>
      )}
    </section>
  );
}

function AiStatusDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { presence, summary, streamStatus, refreshStatus, startClaudeLogin } = useLiveJobs();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const windows = presence?.usage?.windows ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mac Worker ve AI Durumu"
      description="Canlı bağlantı, Claude abonelik kotası ve Gemini görsel motoru hazırlığı."
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={16} />}
            loading={refreshing}
            onClick={() => void handleRefresh()}
          >
            Durumu yenile
          </Button>
          {presence?.online && presence.claude?.status !== "signed_in" && (
            <Button variant="accent" onClick={() => void startClaudeLogin()}>
              Claude girişi başlat
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Kapat
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={summary.macTone}>{summary.macLabel}</Badge>
          <Badge tone={summary.claudeTone}>{summary.claudeLabel}</Badge>
          <Badge tone={summary.geminiTone}>{summary.geminiLabel}</Badge>
        </div>

        <KeyValue
          items={[
            {
              label: "Akış",
              value:
                streamStatus === "open"
                  ? "WebSocket canlı (/api/jobs/stream)"
                  : "HTTP yoklama yedek modunda",
            },
            {
              label: "Son görülme",
              value: presence?.lastSeenAt
                ? formatDateTime(presence.lastSeenAt)
                : "Henüz bağlanmadı",
            },
            {
              label: "Kuyruk",
              value: presence
                ? `${presence.currentJobs.length} çalışan · ${presence.queueLength} sırada`
                : "—",
            },
            {
              label: "Claude hesabı",
              value: presence?.claude ? (
                <>
                  {presence.claude.email ?? presence.claude.status}
                  {presence.claude.plan ? ` (${presence.claude.plan})` : ""}
                  {presence.claude.detail ? ` — ${presence.claude.detail}` : ""}
                </>
              ) : (
                "Rapor bekleniyor"
              ),
            },
            {
              label: "Gemini",
              value: presence?.gemini ? (
                <>
                  Mod: <Mono>{presence.gemini.mode}</Mono>
                  {presence.gemini.defaultModel ? ` · ${presence.gemini.defaultModel}` : ""}
                  {presence.gemini.detail ? ` — ${presence.gemini.detail}` : ""}
                </>
              ) : (
                "Rapor bekleniyor"
              ),
            },
          ]}
        />

        {windows.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h3 className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">
              Claude kullanım pencereleri
            </h3>
            {windows.map((w, idx) => (
              <div key={`${w.kind}-${idx}`} className="rounded-xl bg-surface-2 p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-ink">
                    {w.kind === "five_hour"
                      ? "5 saatlik pencere"
                      : w.kind === "weekly"
                        ? "Haftalık pencere"
                        : "Diğer kota"}
                  </span>
                  <span className="font-mono text-ink-2">
                    {w.usedPercent !== undefined ? `%${Math.round(w.usedPercent)}` : "—"}
                    {w.limited ? " · Sınır doldu" : ""}
                  </span>
                </div>
                {w.usedPercent !== undefined && (
                  <Progress value={w.usedPercent / 100} label={`${w.kind} kullanımı`} />
                )}
                {w.resetsAt && (
                  <p className="mt-1 text-[11px] text-ink-3">
                    Sıfırlanma: {formatDateTime(w.resetsAt)}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </Dialog>
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
