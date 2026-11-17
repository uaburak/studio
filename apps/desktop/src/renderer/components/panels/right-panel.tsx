// The right panel (Wecra "Right panel"): the top bar's tool icons switch its pane; the centre
// never changes. Ayrıntılar (Ortam / Kullanım / Bağlam / Hesaplar) and Arka plan işleri live
// here; Takvim, Medya, Marka and iPhone come from features/ (wave 2B).
import type { AgentRun, Job, Platform, SocialAccount } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { BrandPane } from "../../features/brand/brand-pane.tsx";
import { CalendarPane } from "../../features/calendar/calendar-pane.tsx";
import { PhonePane } from "../../features/devices/phone-pane.tsx";
import { MediaPane } from "../../features/media/media-pane.tsx";
import { openSettings } from "../../features/settings/store.ts";
import { useApi } from "../../lib/api.ts";
import { compactNumber, formatAgo, formatDuration, percentText } from "../../lib/format.ts";
import { effortLabel, modelLabel } from "../../lib/models.ts";
import {
  claudeLine,
  geminiLine,
  jobStatusText,
  jobsBoard,
  jobTitle,
  macLine,
  usageMeters,
} from "../../lib/usage.ts";
import { type PanelPane, panelTitle, useAppStore } from "../../state/app-store.ts";
import {
  isHostUp,
  useAccounts,
  useAgentChoice,
  useConversation,
  useConversations,
  useHost,
  useJobs,
  useSettings,
} from "../../state/studio.tsx";
import { useNow } from "../chat/blocks.tsx";
import { cn, Meter, Switch } from "../ui/controls.tsx";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconLaptop,
  IconLink,
  PlatformIcon,
} from "../ui/icons.tsx";

export const PANEL_WIDTH = 357;
export const PANEL_WIDTH_EXPANDED = 520;

export function RightPanel({ width }: { width: number }) {
  const pane = useAppStore((s) => s.panelPane);
  return (
    <aside
      aria-label={panelTitle(pane)}
      className="scroll-area h-full shrink-0 border-l border-hairline bg-page"
      style={{ width }}
    >
      <div key={pane} className="animate-fade-in px-4 pt-3.5 pb-8">
        <PaneContent pane={pane} />
      </div>
    </aside>
  );
}

function PaneContent({ pane }: { pane: PanelPane }) {
  switch (pane) {
    case "details":
      return <DetailsPane />;
    case "jobs":
      return <JobsPane />;
    case "calendar":
      return <CalendarPane />;
    case "media":
      return <MediaPane />;
    case "brand":
      return <BrandPane />;
    case "phone":
      return <PhonePane />;
  }
}

// --- building blocks ----------------------------------------------------------------------------

export function PanelSection({
  title,
  children,
  last,
}: {
  title: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <section className={cn("pb-4", !last && "mb-4 border-b border-hairline")}>
      <h3 className="mb-2 text-body font-medium text-fg-2">{title}</h3>
      {children}
    </section>
  );
}

export function PanelRow({
  icon,
  label,
  value,
  tone = "muted",
  onClick,
  trailing,
}: {
  icon?: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  tone?: "muted" | "normal" | "success" | "action" | "danger";
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const valueClass = {
    muted: "text-fg-3",
    normal: "text-fg-2",
    success: "text-success",
    action: "text-accent-text",
    danger: "text-danger",
  }[tone];
  const content = (
    <>
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center text-icon">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-left text-body-lg text-fg">{label}</span>
      {value !== undefined && (
        <span
          title={typeof value === "string" ? value : undefined}
          className={cn("min-w-0 max-w-[68%] truncate text-right text-body", valueClass)}
        >
          {value}
        </span>
      )}
      {trailing}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex h-8 w-[calc(100%+16px)] items-center gap-2.5 rounded-full px-2 hover:bg-control"
    >
      {content}
    </button>
  ) : (
    <div className="flex h-8 items-center gap-2.5">{content}</div>
  );
}

// --- Ayrıntılar -----------------------------------------------------------------------------------

function DetailsPane() {
  const route = useAppStore((s) => s.route);
  return (
    <>
      <EnvironmentSection />
      <UsageSection />
      {route.kind === "conversation" ? <ContextSection id={route.id} /> : <NewChatContext />}
      <AccountsSection conversationId={route.kind === "conversation" ? route.id : null} />
    </>
  );
}

function EnvironmentSection() {
  const host = useHost();
  const { settings, update } = useSettings();
  const { presence } = useJobs();
  const showToast = useAppStore((s) => s.showToast);
  const status = host?.status;
  const statusText =
    status?.kind === "running"
      ? "Yerel"
      : status?.kind === "attached"
        ? "Yerel · bağlı"
        : status?.kind === "starting"
          ? "Başlatılıyor"
          : status?.kind === "error"
            ? "Sorun var"
            : "Kapalı";
  return (
    <PanelSection title="Ortam">
      <PanelRow
        icon={<IconLaptop size={16} strokeWidth={1.5} />}
        label="Bu Mac"
        value={statusText}
        tone={status?.kind === "error" ? "danger" : "muted"}
      />
      {status?.kind === "starting" && (
        <p className="mb-1 pl-[26px] text-footnote text-fg-3">{status.message}</p>
      )}
      {status?.kind === "error" && (
        <div className="mb-1 pl-[26px]">
          <p className="selectable text-footnote text-danger">{status.message}</p>
          <button
            type="button"
            className="mt-1 text-footnote text-accent-text hover:underline"
            onClick={() => void window.studio?.host.restart()}
          >
            Yeniden başlat
          </button>
        </div>
      )}
      <PanelRow
        icon={<IconFolder size={16} strokeWidth={1.5} />}
        label="Worker"
        value={macLine(presence)}
      />
      <PanelRow
        icon={<IconLink size={16} strokeWidth={1.5} />}
        label="Uzaktan erişim"
        trailing={
          <Switch
            label="Uzaktan erişim"
            checked={settings.remoteControlEnabled}
            onChange={(on) => {
              update({ remoteControlEnabled: on });
              showToast({ message: "Mac sunucusu yeniden başlayınca geçerli olur." });
            }}
          />
        }
      />
      {host?.lanUrls[0] && (
        <p className="pl-[26px] text-footnote text-fg-3">Yerel ağ: {host.lanUrls[0]}</p>
      )}
    </PanelSection>
  );
}

function UsageSection() {
  const { presence } = useJobs();
  const meters = usageMeters(presence?.usage);
  return (
    <PanelSection title="Kullanım">
      {meters.length === 0 && (
        <p className="text-footnote text-fg-3">Kullanım henüz bildirilmedi.</p>
      )}
      <div className="flex flex-col gap-3">
        {meters.map((m) => (
          <div key={m.kind}>
            <div className="mb-1.5 flex items-baseline justify-between text-body-lg">
              <span className="text-fg">{m.title}</span>
              <span className="text-body text-fg-3">{m.percentText}</span>
            </div>
            <Meter
              percent={m.percent}
              tone={m.kind === "weekly" ? "warning" : m.warning ? "danger" : "info"}
            />
            {m.resetText && <div className="mt-1 text-caption text-fg-3">{m.resetText}</div>}
          </div>
        ))}
      </div>
      <div className="mt-2.5">
        <PanelRow label="Claude" value={claudeLine(presence)} />
        <PanelRow label="Gemini" value={geminiLine(presence)} />
      </div>
    </PanelSection>
  );
}

/** Context window use of the last finished run (input + cache tokens) against 200k / 1M. */
export function contextUse(run: AgentRun | null | undefined) {
  const u = run?.usage;
  if (!u) return null;
  const input = u.inputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const used = input + cacheRead + cacheWrite;
  if (used === 0) return null;
  const limit = /1m|\[1m\]/i.test(run?.model ?? "") || used > 200_000 ? 1_000_000 : 200_000;
  return {
    used,
    limit,
    percent: (used / limit) * 100,
    parts: [
      { label: "Önbellekten", value: cacheRead, color: "bg-info" },
      { label: "Önbelleğe yazılan", value: cacheWrite, color: "bg-accent" },
      { label: "Yeni girdi", value: input, color: "bg-success" },
    ],
  };
}

function ContextSection({ id }: { id: string }) {
  const api = useApi();
  const { state } = useConversation(id);
  const [choice] = useAgentChoice(id);
  const runs = useQuery({
    queryKey: ["runs", id, state?.activeRun?.id ?? null, state?.messages.length ?? 0],
    queryFn: async () => (await api.conversations.runs(id, { limit: 5 })).items,
    enabled: state !== null,
  });
  if (!state) {
    return (
      <PanelSection title="Bağlam">
        <p className="text-footnote text-fg-3">Yükleniyor…</p>
      </PanelSection>
    );
  }
  const finished = (runs.data ?? []).find((r) => r.status === "completed" && r.usage);
  const use = contextUse(finished);
  const open = state.plans.filter((p) => p.status === "draft" || p.status === "proposed").length;
  return (
    <PanelSection title="Bağlam">
      {use && (
        <div className="mb-2.5">
          <div className="mb-1.5 flex items-baseline justify-between text-body-lg">
            <span className="text-fg">{percentText(use.percent)} kullanıldı</span>
            <span className="text-body text-fg-3">
              {compactNumber(use.used)} / {use.limit >= 1_000_000 ? "1M" : "200k"}
            </span>
          </div>
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-control">
            {use.parts.map((p) => (
              <span
                key={p.label}
                className={p.color}
                style={{ width: `${(p.value / use.limit) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {use.parts.map((p) => (
              <li key={p.label} className="flex items-center gap-2 text-body text-fg">
                <span className={cn("size-2 rounded-[2px]", p.color)} />
                <span className="flex-1">{p.label}</span>
                <span className="text-fg-3 tabular-nums">{compactNumber(p.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PanelRow
        label="Mesajlar"
        value={`${state.messages.length}${state.hasMoreMessages ? "+" : ""}`}
      />
      <PanelRow
        label="Görseller"
        value={state.aliases.length ? String(state.aliases.length) : "Yok"}
      />
      <PanelRow
        label="Planlar"
        value={state.plans.length ? `${state.plans.length}${open ? ` · ${open} açık` : ""}` : "Yok"}
      />
      <PanelRow label="Model" value={`${modelLabel(choice.model)} ${effortLabel(choice.effort)}`} />
      {state.activeRun && (
        <PanelRow
          label="Yanıt"
          value={state.activeRun.status === "running" ? "Hazırlanıyor" : "Sırada"}
          tone="normal"
        />
      )}
    </PanelSection>
  );
}

function NewChatContext() {
  const [choice] = useAgentChoice(null);
  return (
    <PanelSection title="Bağlam">
      <PanelRow label="Sohbet" value="Yeni" />
      <PanelRow label="Model" value={`${modelLabel(choice.model)} ${effortLabel(choice.effort)}`} />
    </PanelSection>
  );
}

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
];

export function accountRow(platform: Platform, account: SocialAccount | undefined) {
  if (!account)
    return {
      label: PLATFORMS.find((p) => p.id === platform)?.label ?? platform,
      value: "Bağla",
      tone: "action" as const,
    };
  const label =
    account.handle.trim() || PLATFORMS.find((p) => p.id === platform)?.label || platform;
  if (account.status === "needs_reauth")
    return { label, value: "Yeniden bağla", tone: "action" as const };
  if (account.status === "pending") return { label, value: "Bekliyor", tone: "muted" as const };
  if (account.status === "connected") {
    const health = account.tokenHealth;
    if (health === "expiring_soon" || health === "invalid" || health === "missing_scopes") {
      return { label, value: "Kontrol et", tone: "action" as const };
    }
    return { label, value: "Bağlı", tone: "success" as const };
  }
  return { label, value: "Bağla", tone: "action" as const };
}

function AccountsSection({ conversationId }: { conversationId: string | null }) {
  const accounts = useAccounts();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const conversations = useConversations();
  const brandId = conversationId
    ? ((conversations.data ?? []).find((c) => c.id === conversationId)?.brandId ?? null)
    : currentBrandId;
  if (!brandId) {
    return (
      <PanelSection title="Hesaplar" last>
        <p className="text-footnote text-fg-3">Bu sohbetin markası yok.</p>
      </PanelSection>
    );
  }
  const list = (accounts.data ?? []).filter((a) => a.brandId === brandId);
  return (
    <PanelSection title="Hesaplar" last>
      {PLATFORMS.map((p) => {
        const row = accountRow(
          p.id,
          list.find((a) => a.platform === p.id),
        );
        return (
          <PanelRow
            key={p.id}
            icon={<PlatformIcon platform={p.id} size={16} />}
            label={row.label}
            value={row.value}
            tone={row.tone}
            onClick={() => openSettings("accounts")}
          />
        );
      })}
    </PanelSection>
  );
}

// --- Arka plan işleri ------------------------------------------------------------------------------

function JobsPane() {
  const { jobs, status, controller } = useJobs();
  const host = useHost();
  const [showFinished, setShowFinished] = useState(true);
  const board = jobsBoard(jobs);
  const now = useNow(1_000, board.running.length > 0);
  if (!isHostUp(host)) return <p className="text-footnote text-fg-3">Sunucu hazırlanıyor…</p>;
  return (
    <div className="flex flex-col">
      {status !== "open" && (
        <p className="mb-2 text-footnote text-fg-3">İş akışına bağlanılıyor…</p>
      )}
      {board.running.length + board.queued.length + board.finished.length === 0 && (
        <p className="text-body text-fg-2">Arka planda iş yok.</p>
      )}
      {board.running.length > 0 && (
        <JobGroup title="Çalışıyor" count={board.running.length}>
          {board.running.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              value={formatDuration(now - Date.parse(job.startedAt ?? job.updatedAt))}
              onStop={() => void controller.cancel(job.id)}
            />
          ))}
        </JobGroup>
      )}
      {board.queued.length > 0 && (
        <JobGroup title="Sırada" count={board.queued.length}>
          {board.queued.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              value="sırada"
              onStop={() => void controller.cancel(job.id)}
            />
          ))}
        </JobGroup>
      )}
      {board.finished.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((s) => !s)}
            className="flex h-7 items-center gap-1.5 text-body text-fg-2 hover:text-fg"
          >
            {showFinished ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            Tamamlanan <span className="text-fg-3">{board.finished.length}</span>
          </button>
          {showFinished && (
            <ul className="mt-1 flex flex-col">
              {board.finished.slice(0, 30).map((job) => (
                <li
                  key={job.id}
                  className="flex h-11 items-center gap-2 rounded-[10px] px-3 text-body hover:bg-control"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      job.status === "failed" ? "text-danger" : "text-fg-2",
                    )}
                    title={job.error}
                  >
                    {jobTitle(job)}
                  </span>
                  <span className="shrink-0 text-footnote text-fg-3">
                    {job.status === "succeeded"
                      ? formatAgo(job.finishedAt ?? job.updatedAt)
                      : jobStatusText(job.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function JobGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-2 text-body text-fg-2">
        {title} <span className="text-fg-3">{count}</span>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function JobCard({ job, value, onStop }: { job: Job; value: string; onStop(): void }) {
  const cancelling = job.cancelRequestedAt !== undefined;
  return (
    <div className="rounded-[10px] bg-control px-3 py-2">
      <div className="flex h-6 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body-lg text-fg">{jobTitle(job)}</span>
        <span className="shrink-0 text-body text-fg-3 tabular-nums">
          {cancelling ? "durduruluyor" : value}
        </span>
        <button
          type="button"
          aria-label="İşi durdur"
          title="İşi durdur"
          disabled={cancelling}
          onClick={onStop}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-control-hover text-fg hover:bg-control-pressed disabled:opacity-40"
        >
          <span className="size-2 rounded-[2px] bg-current" />
        </button>
      </div>
      {job.progressMessage && (
        <div className="mt-1 flex items-center gap-1.5 text-footnote text-fg-2">
          {job.progress !== undefined && job.progress >= 1 ? (
            <IconCheck size={12} />
          ) : (
            <span className="size-1 rounded-full bg-current" />
          )}
          <span className="truncate">{job.progressMessage}</span>
          {job.progress !== undefined && (
            <span className="text-fg-3">{percentText(job.progress * 100)}</span>
          )}
        </div>
      )}
    </div>
  );
}
