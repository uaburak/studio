// "Performans" (N15): the current brand's statistics read from Instagram and Facebook — totals,
// the best posts, pillars / formats / weekdays / hours (1,00× = the brand's typical post), the
// hour × weekday heatmap with suggested slots, the weekly trend, followers, and how each
// account's reads go (reconnect, Meta's limit). "Şimdi güncelle" queues a read. LinkedIn member
// posts give no statistics and are not listed.
import {
  type BestTimes,
  type BrandPerformance,
  type PerformanceGroup,
  type Platform,
  slotLabel,
  WEEKDAY_TR,
} from "@studio/contract";
import { useState } from "react";
import { Button, cn, SegmentedControl, Spinner, TagPill } from "../../components/ui/controls.tsx";
import { IconChart, IconRefresh, IconWarning, PlatformIcon } from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { FieldLabel, PageHeader, PaneMessage } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import { useBrandPerformance, useInsightsSync } from "./performance-data.ts";
import {
  followerChange,
  formatCount,
  formatIndex,
  formatRate,
  gridRange,
  heatLevel,
  signed,
  syncStateText,
} from "./performance-model.ts";

type Period = "30" | "90" | "180";
type PlatformFilter = "all" | "instagram" | "facebook";

const PERIODS: { value: Period; label: string }[] = [
  { value: "30", label: "30 gün" },
  { value: "90", label: "90 gün" },
  { value: "180", label: "180 gün" },
];

const PLATFORMS: { value: PlatformFilter; label: string }[] = [
  { value: "all", label: "Tümü" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
];

export default function PerformancePage() {
  const { brandId, brand } = usePanelBrand();
  if (!brandId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Performans" />
        <div className="px-8">
          <PaneMessage
            icon={<IconChart size={18} />}
            text="Performans için kenar çubuğunun altındaki menüden bir marka seç."
          />
        </div>
      </div>
    );
  }
  return <PerformanceBody key={brandId} brandId={brandId} brandName={brand?.name ?? ""} />;
}

export function PerformanceBody({ brandId, brandName }: { brandId: string; brandName: string }) {
  const [period, setPeriod] = useState<Period>("90");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const data = useBrandPerformance(
    brandId,
    Number(period),
    platform === "all" ? null : (platform as Platform),
  );
  const sync = useInsightsSync({ brandId });
  const perf = data.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Performans"
        subtitle={
          brandName
            ? `${brandName} · Instagram ve Facebook istatistikleri (LinkedIn kişisel profilleri istatistik vermiyor)`
            : undefined
        }
        actions={
          <Button
            icon={sync.busy ? <Spinner size={12} /> : <IconRefresh size={14} strokeWidth={1.75} />}
            disabled={sync.busy}
            onClick={() => void sync.start()}
          >
            Şimdi güncelle
          </Button>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SegmentedControl<Period>
            label="Dönem"
            value={period}
            onChange={setPeriod}
            options={PERIODS}
          />
          <SegmentedControl<PlatformFilter>
            label="Platform"
            value={platform}
            onChange={setPlatform}
            options={PLATFORMS}
          />
        </div>
      </PageHeader>
      <div className="scroll-area min-h-0 flex-1 px-8 pb-8">
        {data.isLoading && (
          <p className="flex items-center gap-2 text-body text-fg-2">
            <Spinner size={12} /> İstatistikler yükleniyor…
          </p>
        )}
        {data.error && (
          <PaneMessage icon={<IconWarning size={18} />} text={describeError(data.error)} />
        )}
        {perf && <PerformanceView perf={perf} />}
      </div>
    </div>
  );
}

export function PerformanceView({
  perf,
  now = new Date(),
}: {
  perf: BrandPerformance;
  now?: Date;
}) {
  const openPost = useAppStore((s) => s.openPost);
  return (
    <div className="flex max-w-[1100px] flex-col gap-6">
      <AccountStates perf={perf} now={now} />
      <section aria-label="Özet" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Post" value={formatCount(perf.posts)} />
        <Tile label="Toplam erişim" value={formatCount(perf.totals.reach ?? null)} />
        <Tile label="Ortalama erişim" value={formatCount(perf.avgReach)} />
        <Tile label="Ortalama etkileşim oranı" value={formatRate(perf.avgEngagementRate)} />
        {perf.followers.map((f) => {
          const change = followerChange(f.points);
          return (
            <Tile
              key={f.socialAccountId}
              label={`Takipçi · ${f.handle}`}
              value={formatCount(change.last)}
              detail={change.delta !== null ? `dönemde ${signed(change.delta)}` : undefined}
              platform={f.platform}
            />
          );
        })}
      </section>

      {perf.posts === 0 ? (
        <PaneMessage
          icon={<IconChart size={18} />}
          text="Bu dönemde istatistiği okunmuş post yok."
          detail="Yayınlanan Instagram ve Facebook postlarının istatistikleri yayından 1 saat, 1 gün ve 3 gün sonra, sonra her gün okunur (Mac açıkken)."
        />
      ) : (
        <>
          <section aria-label="En iyi postlar" className="flex flex-col gap-2">
            <h2 className="text-body-lg font-semibold text-fg">En iyi postlar</h2>
            <div className="flex flex-col overflow-hidden rounded-[12px] shadow-[inset_0_0_0_1px_var(--border-hairline)]">
              {perf.topPosts.map((p, i) => (
                <button
                  key={p.scheduleId}
                  type="button"
                  onClick={() => openPost(p.contentId)}
                  className={cn(
                    "flex min-h-11 items-center gap-3 px-3 py-2 text-left hover:bg-control",
                    i > 0 && "border-t border-hairline",
                  )}
                >
                  <PlatformIcon platform={p.platform} size={15} className="shrink-0 text-icon" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{p.title}</span>
                    <span className="block truncate text-footnote text-fg-2">
                      {[p.pillar, p.hook].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </span>
                  <span className="shrink-0 text-footnote text-fg-2">
                    erişim {formatCount(p.metrics.reach ?? null)} · {formatRate(p.engagementRate)}
                  </span>
                  <TagPill
                    tone={p.score >= 1.2 ? "success" : p.score < 0.8 ? "warning" : "neutral"}
                  >
                    {formatIndex(p.score)}
                  </TagPill>
                </button>
              ))}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <GroupTable title="Sütunlar" column="Sütun" groups={perf.byPillar} />
            <GroupTable title="Türler" column="Tür" groups={perf.byFormat} />
            <GroupTable title="Günler" column="Gün" groups={perf.byWeekday} />
            <GroupTable title="Saatler" column="Saat" groups={perf.byHour} />
          </div>

          <Trend perf={perf} />
        </>
      )}
      <BestTimeGrid best={perf.bestTimes} />
      <p className="text-footnote text-fg-3">
        1,00× markanın tipik postu demek: 1,40× tipik posttan %40 daha çok etkileşim aldı (erişime
        göre). Saatler Türkiye saatidir.
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  detail,
  platform,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  platform?: Platform;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[12px] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
      <span className="flex min-w-0 items-center gap-1.5 text-footnote text-fg-2">
        {platform && <PlatformIcon platform={platform} size={12} className="shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
      <span className="text-title font-semibold text-fg tabular-nums">{value}</span>
      {detail && <span className="text-footnote text-fg-3">{detail}</span>}
    </div>
  );
}

function AccountStates({ perf, now }: { perf: BrandPerformance; now: Date }) {
  if (perf.accounts.length === 0) {
    return (
      <PaneMessage
        icon={<IconWarning size={18} />}
        text="Bu markanın bağlı Instagram ya da Facebook hesabı yok."
        detail="Ayarlar → Hesaplar'dan bağlayın; istatistikler yayınlanan postlardan okunur."
      />
    );
  }
  return (
    <section aria-label="Hesaplar" className="flex flex-col gap-1">
      {perf.accounts.map((a) => (
        <p
          key={a.socialAccountId}
          className={cn(
            "flex items-center gap-1.5 text-footnote",
            a.needsReconnect || a.retryAt ? "text-warning" : "text-fg-2",
          )}
        >
          <PlatformIcon platform={a.platform} size={12} className="shrink-0" />
          <span className="font-medium">{a.handle}</span>
          <span className="truncate">· {syncStateText(a, now)}</span>
        </p>
      ))}
    </section>
  );
}

export function GroupTable({
  title,
  column,
  groups,
}: {
  title: string;
  column: string;
  groups: PerformanceGroup[];
}) {
  if (groups.length === 0) return null;
  const maxIndex = Math.max(...groups.map((g) => g.index ?? 0), 1);
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-body-lg font-semibold text-fg">{title}</h2>
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="text-left text-footnote text-fg-3">
            <th className="py-1 font-normal">{column}</th>
            <th className="py-1 text-right font-normal">Post</th>
            <th className="py-1 text-right font-normal">Ort. erişim</th>
            <th className="py-1 text-right font-normal">Etkileşim</th>
            <th className="w-[34%] py-1 pl-3 font-normal">Endeks</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-hairline">
              <td className="max-w-0 truncate py-1.5 text-fg">{g.label}</td>
              <td className="py-1.5 text-right text-fg-2 tabular-nums">{g.posts}</td>
              <td className="py-1.5 text-right text-fg-2 tabular-nums">
                {formatCount(g.avgReach)}
              </td>
              <td className="py-1.5 text-right text-fg-2 tabular-nums">
                {formatRate(g.avgEngagementRate)}
              </td>
              <td className="py-1.5 pl-3">
                <span className="flex items-center gap-2">
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-control">
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        (g.index ?? 0) >= 1 ? "bg-accent" : "bg-fg-3",
                      )}
                      style={{ width: `${Math.round(((g.index ?? 0) / maxIndex) * 100)}%` }}
                    />
                  </span>
                  <span className="w-12 shrink-0 text-right text-footnote text-fg-2 tabular-nums">
                    {formatIndex(g.index)}
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Trend({ perf }: { perf: BrandPerformance }) {
  if (perf.trend.length === 0) return null;
  const max = Math.max(...perf.trend.map((t) => t.reach), 1);
  return (
    <section aria-label="Haftalık gidiş" className="flex flex-col gap-2">
      <h2 className="text-body-lg font-semibold text-fg">Haftalık gidiş</h2>
      <div className="flex h-28 items-end gap-1">
        {perf.trend.map((t) => (
          <div
            key={t.week}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
            title={`${t.week} haftası: ${t.posts} post, erişim ${formatCount(t.reach)}, etkileşim oranı ${formatRate(t.avgEngagementRate)}`}
          >
            <span
              className="w-full max-w-8 rounded-t-[4px] bg-accent"
              style={{ height: `${Math.max(2, Math.round((t.reach / max) * 88))}px` }}
            />
            <span className="text-caption text-fg-3">{t.week.slice(5).replace("-", ".")}</span>
          </div>
        ))}
      </div>
      <p className="text-footnote text-fg-3">Çubuk: haftanın toplam erişimi (Pazartesi başlar).</p>
    </section>
  );
}

const LEVEL_CLASS = [
  "bg-transparent",
  "bg-[color-mix(in_srgb,var(--accent-default)_14%,transparent)]",
  "bg-[color-mix(in_srgb,var(--accent-default)_34%,transparent)]",
  "bg-[color-mix(in_srgb,var(--accent-default)_58%,transparent)]",
  "bg-accent",
] as const;

/** Hour × weekday heatmap (Türkiye time) and the suggested slots. */
export function BestTimeGrid({ best }: { best: BestTimes }) {
  const range = gridRange(best.grid);
  return (
    <section aria-label="En iyi saatler" className="flex flex-col gap-2">
      <h2 className="text-body-lg font-semibold text-fg">En iyi saatler</h2>
      <p className="text-footnote text-fg-2">{best.note}</p>
      {best.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FieldLabel>Önerilen saatler:</FieldLabel>
          {best.suggestions.map((s) => (
            <TagPill key={`${s.weekday}-${s.hour}`} tone="accent">
              {slotLabel(s)}
              {s.score !== null ? ` · ${formatIndex(s.score)}` : ""}
            </TagPill>
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table aria-label="Saat ve gün ısı haritası" className="border-separate border-spacing-0.5">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  className="w-5 text-center text-caption font-normal text-fg-3 tabular-nums"
                >
                  {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {best.grid.map((row, d) => (
              <tr key={WEEKDAY_TR[d]}>
                <th className="pr-2 text-left text-caption font-normal text-fg-2">
                  {WEEKDAY_TR[d]?.slice(0, 3)}
                </th>
                {row.map((v, h) => {
                  const level = heatLevel(v, range);
                  const n = best.counts[d]?.[h] ?? 0;
                  return (
                    <td
                      key={h}
                      data-level={level}
                      title={
                        v === null
                          ? `${WEEKDAY_TR[d]} ${String(h).padStart(2, "0")}:00 · post yok`
                          : `${WEEKDAY_TR[d]} ${String(h).padStart(2, "0")}:00 · ${formatIndex(v)} (${String(n).replace(".", ",")} post)`
                      }
                      className={cn(
                        "size-5 rounded-[4px]",
                        level === 0 ? "shadow-[inset_0_0_0_1px_var(--border-hairline)]" : "",
                        LEVEL_CLASS[level],
                      )}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
