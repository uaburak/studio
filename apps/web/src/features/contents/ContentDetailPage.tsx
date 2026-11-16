import {
  type Content,
  type ContentVersionSummary,
  type Job,
  type Platform,
  Platform as PlatformEnum,
  type Schedule,
} from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../../api.ts";
import { ConfirmDialog } from "../../components/dialog.tsx";
import {
  IconCalendar,
  IconCheck,
  IconEdit,
  IconPlatform,
  IconShield,
  IconSparkle,
  IconTrash,
} from "../../components/icons.tsx";
import { BrandMark, PageHeader, StatusBadge } from "../../components/page.tsx";
import { SlideCarousel } from "../../components/slide-preview.tsx";
import {
  EmptyState,
  ErrorState,
  InlineError,
  Notice,
  SkeletonRows,
} from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Button,
  Card,
  Checkbox,
  cx,
  Field,
  Input,
  Mono,
  Progress,
  SectionTitle,
  Tag,
  Textarea,
} from "../../components/ui.tsx";
import { type HashCheck, verifyVersionHash } from "../../lib/approval.ts";
import { useBrandName } from "../../lib/brand-context.tsx";
import {
  CONTENT_FLOW,
  CONTENT_STATUS,
  contentCapabilities,
  manualTransitions,
  shortHash,
  type TransitionAction,
} from "../../lib/content-status.ts";
import { formatDateTime, formatRelative } from "../../lib/datetime.ts";
import { describeError } from "../../lib/errors.ts";
import {
  CAPTION_LIMITS,
  CONTENT_TYPE_LABELS,
  JOB_STATUS,
  JOB_TYPE_LABELS,
  PLATFORM_LABELS,
  SCHEDULE_STATUS,
  VERSION_ORIGIN_LABELS,
} from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { ScheduleDetailDialog } from "../calendar/ScheduleDetailDialog.tsx";
import { ScheduleDialog } from "../calendar/ScheduleDialog.tsx";
import { generatePayload } from "./generate.ts";
import { useContentCacheUpdate, useContentVersion } from "./hooks.ts";

export function ContentDetailPage() {
  const { contentId = "" } = useParams();
  const api = useApi();
  const brandName = useBrandName();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.contents.one(contentId),
    queryFn: ({ signal }) => api.contents.get(contentId, { signal }),
  });

  const generate = useMutation({
    mutationFn: (content: Content) =>
      api.jobs.create({
        type: "content.generate",
        contentId: content.id,
        payload: generatePayload(content),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success("Üretim işi kuyruğa eklendi", "Worker bağlandığında başlayacak.");
    },
    onError: (e) => toast.error(e, "Üretim işi oluşturulamadı"),
  });

  const remove = useMutation({
    mutationFn: () => api.contents.delete(contentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
      toast.success("İçerik silindi");
      navigate("/icerikler");
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.error(e);
    },
  });

  if (query.isPending) return <SkeletonRows rows={6} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const content = query.data;
  const caps = contentCapabilities(content);

  return (
    <>
      <PageHeader
        back={{ to: "/icerikler", label: "İçerikler" }}
        eyebrow={
          <>
            <Link
              to={`/markalar/${content.brandId}`}
              className="inline-flex items-center gap-1.5 hover:text-ink"
            >
              <BrandMark id={content.brandId} name={brandName(content.brandId)} size={18} />
              {brandName(content.brandId)}
            </Link>
            <Tag>{CONTENT_TYPE_LABELS[content.type]}</Tag>
            <span>Güncellendi {formatRelative(content.updatedAt)}</span>
          </>
        }
        title={content.title}
        actions={
          <>
            <Button
              variant="accent"
              icon={<IconSparkle size={18} />}
              loading={generate.isPending}
              onClick={() => generate.mutate(content)}
              disabled={!caps.canAddVersion}
              title={
                caps.canAddVersion ? "Brif ile yeni sürüm üret" : "Bu durumda yeni sürüm üretilemez"
              }
            >
              Üret
            </Button>
            {caps.canDelete && (
              <Button
                variant="ghost"
                icon={<IconTrash size={18} />}
                onClick={() => setConfirmDelete(true)}
              >
                Sil
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-6">
          <StatusPanel content={content} onSchedule={() => setScheduling(true)} />
          <PreviewPanel content={content} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <BriefPanel content={content} />
          <CaptionPanel content={content} />
          <ContentSchedules content={content} />
          <ContentJobs contentId={content.id} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="İçerik silinsin mi?"
        message="İçerik, tüm sürümleri ve slaytlarıyla birlikte kalıcı olarak silinir. Bu işlem geri alınamaz."
        confirmLabel="Kalıcı olarak sil"
        danger
      />
      <ScheduleDialog open={scheduling} onClose={() => setScheduling(false)} content={content} />
    </>
  );
}

// --- Status & actions --------------------------------------------------------

function StatusPanel({ content, onSchedule }: { content: Content; onSchedule: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const updateCache = useContentCacheUpdate();
  const caps = contentCapabilities(content);
  const actions = manualTransitions(content.status, content.currentVersion !== null);
  const current = useContentVersion(content.id, content.currentVersion?.version);
  const [check, setCheck] = useState<HashCheck | null>(null);
  const [confirm, setConfirm] = useState<TransitionAction | null>(null);

  // Verify the current version's hash locally as soon as its slides arrive.
  useEffect(() => {
    let alive = true;
    setCheck(null);
    if (current.data) {
      void verifyVersionHash(current.data).then((result) => {
        if (alive) setCheck(result);
      });
    }
    return () => {
      alive = false;
    };
  }, [current.data]);

  const onConflict = (error: unknown) => {
    if (describeError(error).conflict) {
      void qc.invalidateQueries({ queryKey: queryKeys.contents.one(content.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.contents.versions(content.id) });
    }
  };

  const approve = useMutation({
    mutationFn: async () => {
      if (!current.data || current.data.id !== content.currentVersion?.id) {
        throw new Error("Güncel sürüm henüz yüklenmedi.");
      }
      const result = await verifyVersionHash(current.data);
      if (result.kind === "mismatch") {
        throw new Error("Önizlenen slaytların hash'i sunucudakiyle eşleşmiyor. Sayfayı yenileyin.");
      }
      return api.contents.approve(content.id, result.hash);
    },
    onSuccess: (updated) => {
      updateCache(updated);
      toast.success(`Sürüm ${updated.approval ? updated.currentVersion?.version : ""} onaylandı`);
    },
    onError: onConflict,
  });

  const transition = useMutation({
    mutationFn: (to: TransitionAction["to"]) => api.contents.transition(content.id, to),
    onSuccess: (updated) => {
      updateCache(updated);
      setConfirm(null);
      toast.success(`Durum: ${CONTENT_STATUS[updated.status].label}`);
    },
    onError: (e) => {
      setConfirm(null);
      onConflict(e);
    },
  });

  const status = CONTENT_STATUS[content.status];
  const flowIndex = CONTENT_FLOW.indexOf(
    content.status === "publishing" ? "scheduled" : content.status,
  );
  const error = approve.error ?? transition.error;

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge meta={status} className="h-7 px-3 text-[13px]" />
        {status.hint && <span className="text-[13px] text-ink-2">{status.hint}</span>}
      </div>

      {/* Lifecycle strip */}
      <ol className="mt-5 grid grid-cols-5 gap-1.5" aria-label="İçerik yaşam döngüsü">
        {CONTENT_FLOW.map((s, i) => {
          const reached = content.status === "failed" ? i <= 2 : i <= flowIndex;
          const here = s === content.status;
          return (
            <li key={s} className="flex flex-col gap-1.5" aria-current={here ? "step" : undefined}>
              <span
                className={cx(
                  "h-1 rounded-full",
                  reached ? (here ? "bg-accent" : "bg-ink") : "bg-surface-3",
                )}
              />
              <span
                className={cx(
                  "truncate text-[11px] sm:text-[12px]",
                  here ? "font-semibold text-ink" : "text-ink-3",
                )}
              >
                {CONTENT_STATUS[s].label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Approval facts */}
      <div className="mt-5 flex flex-col gap-2 text-[13px]">
        {content.currentVersion ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-2">
            <span>
              Güncel sürüm{" "}
              <strong className="font-semibold text-ink">v{content.currentVersion.version}</strong>
            </span>
            <Mono className="text-ink-3">{shortHash(content.currentVersion.contentHash)}</Mono>
            <HashBadge check={check} />
          </div>
        ) : (
          <p className="text-ink-3">
            Henüz sürüm yok. “Üret” ile üretim işi başlatın ya da API ile sürüm ekleyin.
          </p>
        )}
        {content.approval && (
          <p className="flex flex-wrap items-center gap-x-2 text-ink-2">
            <IconShield size={16} className="text-good" />
            Onaylandı: {formatDateTime(content.approval.approvedAt)} ·{" "}
            <Mono className="text-ink-3">{shortHash(content.approval.contentHash)}</Mono>
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {caps.canApprove && (
          <Button
            variant="primary"
            icon={<IconCheck size={18} />}
            loading={approve.isPending}
            disabled={!current.data || check?.kind === "mismatch"}
            onClick={() => approve.mutate()}
          >
            v{content.currentVersion?.version} sürümünü onayla
          </Button>
        )}
        {(caps.canSchedule || content.status === "approved") && (
          <Button
            variant={caps.canApprove ? "secondary" : "primary"}
            icon={<IconCalendar size={18} />}
            onClick={onSchedule}
            disabled={!caps.canSchedule}
            title={caps.scheduleBlockedReason ?? undefined}
          >
            Zamanla
          </Button>
        )}
        {actions.map((action) => (
          <Button
            key={action.to}
            variant={action.intent === "danger" ? "danger" : "secondary"}
            loading={transition.isPending && transition.variables === action.to}
            onClick={() => (action.confirm ? setConfirm(action) : transition.mutate(action.to))}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {!caps.canApprove && caps.approveBlockedReason && content.status === "draft" && (
        <p className="mt-3 text-[13px] text-ink-3">{caps.approveBlockedReason}</p>
      )}
      {caps.scheduleBlockedReason && content.status === "approved" && (
        <p className="mt-3 text-[13px] text-ink-3">{caps.scheduleBlockedReason}</p>
      )}

      {error ? (
        <div className="mt-4">
          <InlineError error={error} />
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && transition.mutate(confirm.to)}
        loading={transition.isPending}
        title={confirm?.label ?? ""}
        message={confirm?.confirm ?? ""}
        confirmLabel={confirm?.label ?? ""}
        danger
      />
    </Card>
  );
}

function HashBadge({ check }: { check: HashCheck | null }) {
  if (!check) return null;
  if (check.kind === "verified")
    return (
      <span
        className="inline-flex items-center gap-1 text-good"
        title="Slaytlardan yeniden hesaplanan hash sunucudakiyle aynı."
      >
        <IconCheck size={14} /> doğrulandı
      </span>
    );
  if (check.kind === "unverifiable")
    return (
      <span
        className="text-ink-3"
        title="Tarayıcı güvenli bağlamda değil (WebCrypto yok); sunucunun hash'i kullanılır."
      >
        yerelde doğrulanamadı
      </span>
    );
  return <span className="font-medium text-bad">hash uyuşmuyor</span>;
}

// --- Preview -----------------------------------------------------------------

function PreviewPanel({ content }: { content: Content }) {
  const api = useApi();
  const currentNo = content.currentVersion?.version ?? null;
  const [selected, setSelected] = useState<number | null>(currentNo);

  useEffect(() => {
    setSelected(currentNo);
  }, [currentNo]);

  const versions = useQuery({
    queryKey: queryKeys.contents.versions(content.id),
    queryFn: ({ signal }) => api.contents.versions.list(content.id, { limit: 100 }, { signal }),
  });
  const version = useContentVersion(content.id, selected);
  const summary = versions.data?.items.find((v) => v.version === selected);

  if (!content.currentVersion) {
    return (
      <Card className="p-5 sm:p-6">
        <SectionTitle>Önizleme</SectionTitle>
        <div className="mt-4">
          <EmptyState title="Henüz tasarım yok" glyph={<IconSparkle size={24} />}>
            Üretim hattı (Mac worker) bağlandığında “Üret” ile oluşan sürümler burada slayt slayt
            görünecek.
          </EmptyState>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-6">
      <SectionTitle>Önizleme</SectionTitle>
      <div className="mt-4 flex flex-col-reverse gap-5">
        <div className="min-w-0 flex-1">
          {version.isPending ? (
            <div className="skeleton aspect-[4/5] max-h-[640px] rounded-2xl" />
          ) : version.error ? (
            <ErrorState error={version.error} onRetry={() => void version.refetch()} />
          ) : (
            <SlideCarousel
              key={version.data.id}
              slides={version.data.slides}
              title={`Sürüm ${version.data.version} önizlemesi`}
            />
          )}
          {selected !== currentNo && (
            <div className="mt-4">
              <Notice tone="warn">
                Eski bir sürüme bakıyorsunuz. Onay yalnızca güncel sürüme (v{currentNo})
                verilebilir.
              </Notice>
            </div>
          )}
          {summary?.note && <p className="mt-3 text-sm text-ink-2">Not: {summary.note}</p>}
        </div>

        <nav aria-label="Sürümler">
          <h3 className="mb-2 text-[12px] font-medium text-ink-3">Sürümler</h3>
          {versions.error ? (
            <ErrorState error={versions.error} compact />
          ) : (
            <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {(versions.data?.items ?? []).map((v) => (
                <li key={v.id} className="shrink-0">
                  <VersionButton
                    v={v}
                    active={v.version === selected}
                    current={v.version === currentNo}
                    approved={content.approval?.versionId === v.id}
                    onSelect={() => setSelected(v.version)}
                  />
                </li>
              ))}
            </ul>
          )}
        </nav>
      </div>
    </Card>
  );
}

function VersionButton({
  v,
  active,
  current,
  approved,
  onSelect,
}: {
  v: ContentVersionSummary;
  active: boolean;
  current: boolean;
  approved: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cx(
        "flex w-44 flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left ring-1 ring-inset transition-colors",
        active ? "bg-ink text-bg ring-ink" : "bg-surface ring-line hover:ring-line-strong",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">v{v.version}</span>
        {current && (
          <span className={cx("text-[11px]", active ? "opacity-70" : "text-accent")}>güncel</span>
        )}
        {approved && (
          <IconShield size={14} className={active ? "" : "text-good"} aria-label="onaylı" />
        )}
      </span>
      <span className={cx("text-[12px]", active ? "opacity-70" : "text-ink-3")}>
        {VERSION_ORIGIN_LABELS[v.origin]} · {v.slideCount} slayt
      </span>
      <span className={cx("text-[11px]", active ? "opacity-60" : "text-ink-3")}>
        {formatRelative(v.createdAt)}
      </span>
    </button>
  );
}

// --- Brief -------------------------------------------------------------------

function BriefPanel({ content }: { content: Content }) {
  const api = useApi();
  const toast = useToast();
  const updateCache = useContentCacheUpdate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(content.title);
  const [brief, setBrief] = useState(content.brief);

  useEffect(() => {
    if (!editing) {
      setTitle(content.title);
      setBrief(content.brief);
    }
  }, [content.title, content.brief, editing]);

  const save = useMutation({
    mutationFn: () => api.contents.update(content.id, { title: title.trim(), brief }),
    onSuccess: (updated) => {
      updateCache(updated);
      setEditing(false);
      toast.success("Brif kaydedildi");
    },
  });

  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle
        action={
          !editing && (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconEdit size={16} />}
              onClick={() => setEditing(true)}
            >
              Düzenle
            </Button>
          )
        }
      >
        Brif
      </SectionTitle>
      {editing ? (
        <form
          className="mt-3 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) save.mutate();
          }}
        >
          <Field label="Başlık">
            {(p) => (
              <Input
                {...p}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
              />
            )}
          </Field>
          <Field label="Brif" hint="Başlık ve brif değişikliği onayı etkilemez.">
            {(p) => (
              <Textarea
                {...p}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={8}
                maxLength={20000}
              />
            )}
          </Field>
          <InlineError error={save.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Vazgeç
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Kaydet
            </Button>
          </div>
        </form>
      ) : content.brief.trim() ? (
        <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {content.brief}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-3">
          Brif yazılmamış. Üretimden önce ne istediğinizi anlatın.
        </p>
      )}
    </Card>
  );
}

// --- Caption & platforms -----------------------------------------------------

function CaptionPanel({ content }: { content: Content }) {
  const api = useApi();
  const toast = useToast();
  const updateCache = useContentCacheUpdate();
  const caps = contentCapabilities(content);
  const [caption, setCaption] = useState(content.caption);
  const [platforms, setPlatforms] = useState<Platform[]>(content.targetPlatforms);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setCaption(content.caption);
    setPlatforms(content.targetPlatforms);
  }, [content.caption, content.targetPlatforms]);

  const samePlatforms =
    platforms.length === content.targetPlatforms.length &&
    platforms.every((p) => content.targetPlatforms.includes(p));
  const dirty = caption !== content.caption || !samePlatforms;

  const save = useMutation({
    mutationFn: () =>
      api.contents.update(content.id, {
        ...(caption !== content.caption ? { caption } : {}),
        ...(!samePlatforms ? { targetPlatforms: platforms } : {}),
      }),
    onSuccess: (updated) => {
      updateCache(updated);
      setConfirming(false);
      toast.success(
        "Metin kaydedildi",
        content.approval && !updated.approval
          ? "Onay kaldırıldı; içerik taslağa döndü."
          : undefined,
      );
    },
    onError: () => setConfirming(false),
  });

  const limit = Math.min(...platforms.map((p) => CAPTION_LIMITS[p]), 10_000);
  const over = caption.length > limit;

  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle>Paylaşım metni</SectionTitle>
      <form
        className="mt-3 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (caps.captionEditRevokesApproval) setConfirming(true);
          else save.mutate();
        }}
      >
        <Field
          label="Açıklama"
          hint={
            <span className={cx("tabular-nums", over && "font-medium text-bad")}>
              {caption.length.toLocaleString("tr-TR")} / {limit.toLocaleString("tr-TR")} karakter
            </span>
          }
        >
          {(p) => (
            <Textarea
              {...p}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={7}
              maxLength={10000}
              disabled={caps.captionLocked}
              placeholder="Paylaşımda görünecek metin, hashtag'ler…"
            />
          )}
        </Field>
        <fieldset disabled={caps.captionLocked}>
          <legend className="mb-2 text-[13px] font-medium text-ink">Hedef platformlar</legend>
          <div className="flex flex-col gap-2">
            {PlatformEnum.options.map((p) => (
              <Checkbox
                key={p}
                checked={platforms.includes(p)}
                disabled={caps.captionLocked}
                onChange={(on) =>
                  setPlatforms((list) => (on ? [...list, p] : list.filter((x) => x !== p)))
                }
              >
                <span className="inline-flex items-center gap-1.5">
                  <IconPlatform platform={p} size={16} />
                  {PLATFORM_LABELS[p]}
                </span>
              </Checkbox>
            ))}
          </div>
        </fieldset>
        {caps.captionEditRevokesApproval && dirty && (
          <Notice tone="warn">
            Kaydederseniz onay kalkar, içerik taslağa döner ve bekleyen zamanlamalar iptal edilir.
          </Notice>
        )}
        <InlineError error={save.error} />
        {!caps.captionLocked && (
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setCaption(content.caption);
                  setPlatforms(content.targetPlatforms);
                }}
              >
                Geri al
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || over}
              loading={save.isPending}
            >
              Kaydet
            </Button>
          </div>
        )}
      </form>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => save.mutate()}
        loading={save.isPending}
        title="Onay kalksın mı?"
        message="Açıklama ya da platform değişikliği onaylanan içeriği değiştirir. İçerik taslağa döner, bekleyen zamanlamalar iptal edilir ve yeniden onay gerekir."
        confirmLabel="Kaydet ve onayı kaldır"
        danger
      />
    </Card>
  );
}

// --- Schedules & jobs for this content ----------------------------------------

function ContentSchedules({ content }: { content: Content }) {
  const api = useApi();
  const [open, setOpen] = useState<Schedule | null>(null);
  const query = useQuery({
    queryKey: queryKeys.schedules.list({ contentId: content.id }),
    queryFn: ({ signal }) => api.schedules.list({ contentId: content.id, limit: 50 }, { signal }),
  });
  const items = query.data?.items ?? [];
  if (!query.isPending && !query.error && items.length === 0) return null;

  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle
        action={
          <Link to="/takvim" className="text-[13px] font-medium text-ink-2 hover:text-ink">
            Takvim
          </Link>
        }
      >
        Zamanlamalar
      </SectionTitle>
      {query.error ? (
        <ErrorState error={query.error} compact />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setOpen(s)}
                className={cx(
                  "flex w-full items-center gap-3 rounded-xl p-3 text-left ring-1 ring-line ring-inset hover:ring-line-strong",
                  s.status === "cancelled" && "opacity-60",
                )}
              >
                <IconPlatform platform={s.platform} className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">
                    {formatDateTime(s.scheduledAt)}
                  </span>
                  <span className="block text-[12px] text-ink-3">
                    {PLATFORM_LABELS[s.platform]}
                  </span>
                </span>
                <StatusBadge meta={SCHEDULE_STATUS[s.status]} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ScheduleDetailDialog
        schedule={open}
        contentTitle={content.title}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}

const ACTIVE_JOB = (j: Job) => j.status === "queued" || j.status === "running";

function ContentJobs({ contentId }: { contentId: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.jobs.list({ contentId }),
    queryFn: ({ signal }) => api.jobs.list({ contentId, limit: 10 }, { signal }),
    refetchInterval: (q) => (q.state.data?.items.some(ACTIVE_JOB) ? 4000 : false),
  });
  const items = query.data?.items ?? [];
  if (!query.isPending && !query.error && items.length === 0) return null;

  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle>Üretim işleri</SectionTitle>
      {query.error ? (
        <ErrorState error={query.error} compact />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((job) => (
            <li key={job.id}>
              <Link
                to={`/isler/${job.id}`}
                className="flex flex-col gap-2 rounded-xl p-3 ring-1 ring-line ring-inset hover:ring-line-strong"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{JOB_TYPE_LABELS[job.type]}</span>
                  <StatusBadge meta={JOB_STATUS[job.status]} />
                </span>
                {job.status === "running" && job.progress !== undefined && (
                  <Progress value={job.progress} label="İlerleme" />
                )}
                <span className="text-[12px] text-ink-3">
                  {job.status === "queued" ? "Worker bekleniyor · " : ""}
                  {formatRelative(job.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
