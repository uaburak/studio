import type { Schedule } from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconPlatform } from "../../components/icons.tsx";
import { StatusBadge } from "../../components/page.tsx";
import { ErrorState, InlineError, Notice } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import { Button, KeyValue, Mono, Spinner } from "../../components/ui.tsx";
import { useBrandName } from "../../lib/brand-context.tsx";
import { shortHash } from "../../lib/content-status.ts";
import { formatDateTime, formatOffset, userTimeZone } from "../../lib/datetime.ts";
import { PLATFORM_LABELS, PUBLISH_LOG_STATUS, SCHEDULE_STATUS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";

export function ScheduleDetailDialog({
  schedule,
  contentTitle,
  onClose,
}: {
  schedule: Schedule | null;
  contentTitle?: string | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const brandName = useBrandName();
  const timeZone = userTimeZone();
  const [confirming, setConfirming] = useState(false);

  const logs = useQuery({
    queryKey: queryKeys.schedules.logs(schedule?.id ?? ""),
    queryFn: ({ signal }) => api.schedules.logs(schedule?.id ?? "", { limit: 50 }, { signal }),
    enabled: Boolean(schedule),
  });

  const account = useQuery({
    queryKey: ["accounts", "one", schedule?.socialAccountId ?? ""],
    queryFn: ({ signal }) => api.socialAccounts.get(schedule?.socialAccountId ?? "", { signal }),
    enabled: Boolean(schedule),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.schedules.cancel(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
      void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
      toast.success("Zamanlama iptal edildi");
      setConfirming(false);
      onClose();
    },
  });

  const close = () => {
    setConfirming(false);
    cancel.reset();
    onClose();
  };

  const cancellable = schedule?.status === "pending";

  return (
    <Dialog
      open={schedule !== null}
      onClose={close}
      title={contentTitle ?? "Zamanlama"}
      size="md"
      footer={
        schedule && (
          <>
            <Button variant="ghost" onClick={close}>
              Kapat
            </Button>
            {cancellable &&
              (confirming ? (
                <Button
                  variant="accent"
                  loading={cancel.isPending}
                  onClick={() => cancel.mutate(schedule.id)}
                >
                  Evet, iptal et
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  Zamanlamayı iptal et
                </Button>
              ))}
          </>
        )
      }
    >
      {schedule && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge meta={SCHEDULE_STATUS[schedule.status]} />
            <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
              <IconPlatform platform={schedule.platform} size={16} />
              {PLATFORM_LABELS[schedule.platform]}
            </span>
          </div>

          {schedule.status === "pending" && (
            <Notice tone="warn">
              <strong>Henüz otomatik paylaşılmayacak.</strong> {SCHEDULE_STATUS.pending.hint}
            </Notice>
          )}
          {confirming && (
            <Notice tone="neutral">
              İptal edilince içerik başka bekleyen zamanlaması yoksa “Onaylandı” durumuna döner.
              Geri alınamaz; yeniden zamanlayabilirsiniz.
            </Notice>
          )}

          <KeyValue
            items={[
              {
                label: "Zaman",
                value: (
                  <>
                    {formatDateTime(schedule.scheduledAt, timeZone)}{" "}
                    <span className="text-ink-3">
                      ({formatOffset(new Date(schedule.scheduledAt), timeZone)})
                    </span>
                    <br />
                    <Mono className="text-ink-3">{schedule.scheduledAt}</Mono>
                  </>
                ),
              },
              { label: "Marka", value: brandName(schedule.brandId) },
              {
                label: "Hesap",
                value: account.data ? (
                  account.data.handle
                ) : (
                  <Mono className="text-ink-3">{schedule.socialAccountId}</Mono>
                ),
              },
              {
                label: "İçerik",
                value: (
                  <Link
                    className="font-medium text-accent underline-offset-2 hover:underline"
                    to={`/icerikler/${schedule.contentId}`}
                  >
                    İçeriği aç
                  </Link>
                ),
              },
              { label: "Sürüm hash'i", value: <Mono>{shortHash(schedule.contentHash)}</Mono> },
              ...(schedule.cancelledAt
                ? [{ label: "İptal", value: formatDateTime(schedule.cancelledAt, timeZone) }]
                : []),
              { label: "Oluşturuldu", value: formatDateTime(schedule.createdAt, timeZone) },
            ]}
          />

          <section>
            <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-ink-2 uppercase">
              Yayın kayıtları
            </h3>
            {logs.isPending ? (
              <Spinner />
            ) : logs.error ? (
              <ErrorState error={logs.error} compact />
            ) : logs.data.items.length === 0 ? (
              <p className="text-sm text-ink-3">Henüz yayın denemesi yok.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {logs.data.items.map((log) => (
                  <li key={log.id} className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-ink-3">#{log.attempt}</span>
                      <StatusBadge meta={PUBLISH_LOG_STATUS[log.status]} />
                      <span className="text-ink-3">{formatDateTime(log.startedAt, timeZone)}</span>
                    </div>
                    {log.externalPostId && <Mono className="mt-1 block">{log.externalPostId}</Mono>}
                    {log.error && <p className="mt-1 text-bad">{log.error}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <InlineError error={cancel.error} />
        </div>
      )}
    </Dialog>
  );
}
