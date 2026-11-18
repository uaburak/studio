// The post detail's "Performans" (N15): for a post published on Instagram or Facebook, each
// account's numbers (reach, views, likes …), the engagement rate, the reads so far (1 h, 24 h,
// 72 h, daily), what is missing and why, and "Şimdi güncelle".
import { type ContentPerformance, METRIC_LABEL, type Schedule } from "@studio/contract";
import { useState } from "react";
import { Button, cn, Spinner, TagPill } from "../../components/ui/controls.tsx";
import { IconRefresh, PlatformIcon } from "../../components/ui/icons.tsx";
import { useContentPerformance, useInsightsSync } from "../performance/performance-data.ts";
import {
  ago,
  formatMetric,
  formatRate,
  hoursLabel,
  insightStatusText,
  METRIC_ORDER,
  metricEntries,
} from "../performance/performance-model.ts";

/** True when the post went out on an account whose statistics can be read. */
export function hasReadablePublish(schedules: readonly Schedule[]): boolean {
  return schedules.some(
    (s) => s.status === "published" && (s.platform === "instagram" || s.platform === "facebook"),
  );
}

export function PostPerformancePanel({
  contentId,
  schedules,
}: {
  contentId: string;
  schedules: readonly Schedule[];
}) {
  const readable = hasReadablePublish(schedules);
  const data = useContentPerformance(readable ? contentId : null);
  const sync = useInsightsSync({ contentId });
  if (!readable) return null;
  return (
    <section aria-label="Performans" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-footnote font-medium text-fg-2">Performans</h3>
        <Button
          variant="ghost"
          size="sm"
          icon={sync.busy ? <Spinner size={11} /> : <IconRefresh size={12} strokeWidth={1.75} />}
          disabled={sync.busy}
          onClick={() => void sync.start()}
        >
          Şimdi güncelle
        </Button>
      </div>
      {data.isLoading && (
        <span className="flex items-center gap-1.5 text-footnote text-fg-3">
          <Spinner size={11} /> İstatistikler yükleniyor…
        </span>
      )}
      {data.data && <PerformanceCards perf={data.data} />}
    </section>
  );
}

export function PerformanceCards({
  perf,
  now = new Date(),
}: {
  perf: ContentPerformance;
  now?: Date;
}) {
  if (perf.posts.length === 0) {
    return (
      <p className="text-footnote text-fg-3">
        İstatistikler yayından bir saat sonra okunur (Mac açıkken).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {perf.posts.map((p) => (
        <AccountCard
          key={p.scheduleId}
          post={p}
          reconnect={perf.needsReconnect.includes(p.socialAccountId)}
          now={now}
        />
      ))}
    </div>
  );
}

function AccountCard({
  post,
  reconnect,
  now,
}: {
  post: ContentPerformance["posts"][number];
  reconnect: boolean;
  now: Date;
}) {
  const [history, setHistory] = useState(false);
  const entries = metricEntries(post.metrics);
  const note = insightStatusText(post);
  const columns = METRIC_ORDER.filter((k) =>
    post.snapshots.some((s) => typeof s.metrics[k] === "number"),
  ).slice(0, 5);
  return (
    <div className="flex flex-col gap-2 rounded-[12px] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
      <div className="flex items-center gap-2">
        <PlatformIcon platform={post.platform} size={14} className="shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate text-body text-fg">{post.accountHandle}</span>
        {post.engagementRate !== null && (
          <TagPill tone="accent">etkileşim {formatRate(post.engagementRate)}</TagPill>
        )}
      </div>
      {entries.length > 0 && (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="truncate text-caption text-fg-3">{METRIC_LABEL[key]}</dt>
              <dd className="text-body font-medium text-fg tabular-nums">
                {formatMetric(key, value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {note && (
        <p className={cn("text-footnote", post.status === "ok" ? "text-fg-2" : "text-warning")}>
          {note}
        </p>
      )}
      {reconnect && (
        <p className="text-footnote text-warning">
          Erişim ve görüntülenme için hesabı yeniden bağlayıp istatistik iznini verin (Ayarlar →
          Hesaplar).
        </p>
      )}
      <div className="flex items-center gap-2 text-footnote text-fg-3">
        <span className="flex-1">
          Son okuma: {ago(post.syncedAt, now)}
          {post.nextSyncAt
            ? ` · sonraki: ${new Date(post.nextSyncAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            : ""}
        </span>
        {post.snapshots.length > 0 && (
          <button
            type="button"
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
            className="text-accent-text hover:underline"
          >
            {history ? "Geçmişi gizle" : `Geçmiş (${post.snapshots.length})`}
          </button>
        )}
      </div>
      {history && (
        <table aria-label="Okuma geçmişi" className="w-full border-collapse text-footnote">
          <thead>
            <tr className="text-left text-fg-3">
              <th className="py-0.5 font-normal">Zaman</th>
              {columns.map((k) => (
                <th key={k} className="py-0.5 text-right font-normal">
                  {METRIC_LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {post.snapshots.map((s) => (
              <tr key={s.at} className="border-t border-hairline">
                <td className="py-0.5 text-fg-2">{hoursLabel(s.hoursAfterPublish)}</td>
                {columns.map((k) => (
                  <td key={k} className="py-0.5 text-right text-fg tabular-nums">
                    {formatMetric(k, s.metrics[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
