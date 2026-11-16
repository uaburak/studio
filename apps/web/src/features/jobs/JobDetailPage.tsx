import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useApi } from "../../api.ts";
import { PageHeader, StatusBadge } from "../../components/page.tsx";
import { ErrorState, Notice, SkeletonRows } from "../../components/states.tsx";
import { Card, CodeBlock, KeyValue, Mono, Progress, SectionTitle } from "../../components/ui.tsx";
import { useBrandName } from "../../lib/brand-context.tsx";
import { formatDateTime } from "../../lib/datetime.ts";
import { formatPercent, prettyJson } from "../../lib/format.ts";
import { JOB_STATUS, JOB_TYPE_LABELS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { isActiveJob } from "./JobsPage.tsx";

export function JobDetailPage() {
  const { jobId = "" } = useParams();
  const api = useApi();
  const brandName = useBrandName();
  const query = useQuery({
    queryKey: queryKeys.jobs.one(jobId),
    queryFn: ({ signal }) => api.jobs.get(jobId, { signal }),
    refetchInterval: (q) => (q.state.data && isActiveJob(q.state.data) ? 2000 : false),
  });

  if (query.isPending) return <SkeletonRows rows={4} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const job = query.data;

  return (
    <>
      <PageHeader
        back={{ to: "/isler", label: "İşler" }}
        eyebrow={<Mono>{job.id}</Mono>}
        title={JOB_TYPE_LABELS[job.type]}
        actions={<StatusBadge meta={JOB_STATUS[job.status]} className="h-8 px-3 text-[13px]" />}
      />

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="flex flex-col gap-5 self-start p-5 sm:p-6">
          {job.status === "queued" && (
            <Notice tone="info">
              Sırada: Mac worker bu işi alınca “Çalışıyor”a geçer. Üretim hattı henüz bağlı olmadığı
              için sonuç üretilmeyecek.
            </Notice>
          )}
          {job.progress !== undefined && (
            <div className="flex items-center gap-3">
              <Progress value={job.progress} label="İlerleme" />
              <span className="font-mono text-[12px] text-ink-2">
                {formatPercent(job.progress)}
              </span>
            </div>
          )}
          <KeyValue
            items={[
              { label: "Tür", value: <Mono>{job.type}</Mono> },
              { label: "Marka", value: job.brandId ? brandName(job.brandId) : "—" },
              {
                label: "İçerik",
                value: job.contentId ? (
                  <Link
                    to={`/icerikler/${job.contentId}`}
                    className="font-medium text-accent underline-offset-2 hover:underline"
                  >
                    İçeriği aç
                  </Link>
                ) : (
                  "—"
                ),
              },
              { label: "Oluşturuldu", value: formatDateTime(job.createdAt) },
              { label: "Başladı", value: job.startedAt ? formatDateTime(job.startedAt) : "—" },
              { label: "Bitti", value: job.finishedAt ? formatDateTime(job.finishedAt) : "—" },
              { label: "Güncellendi", value: formatDateTime(job.updatedAt) },
            ]}
          />
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          {job.error && (
            <Card className="p-5 sm:p-6">
              <SectionTitle>Hata</SectionTitle>
              <pre className="mt-3 overflow-auto rounded-xl p-4 font-mono text-[12px] whitespace-pre-wrap tint-bad">
                {job.error}
              </pre>
            </Card>
          )}
          <Card className="p-5 sm:p-6">
            <SectionTitle>Girdi (payload)</SectionTitle>
            <div className="mt-3">
              <CodeBlock label="Girdi">{prettyJson(job.payload)}</CodeBlock>
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <SectionTitle>Sonuç</SectionTitle>
            <div className="mt-3">
              {job.output ? (
                <CodeBlock label="Sonuç">{prettyJson(job.output)}</CodeBlock>
              ) : (
                <p className="text-sm text-ink-3">Henüz sonuç yok.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
