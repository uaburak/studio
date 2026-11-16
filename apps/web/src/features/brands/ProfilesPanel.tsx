import type { AgentEffort, AgentModel, BrandProfile } from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { fetchAllPages, useApi } from "../../api.ts";
import { ConfirmDialog, Dialog } from "../../components/dialog.tsx";
import { IconCheck, IconEdit, IconPlus, IconSparkle } from "../../components/icons.tsx";
import { StatusBadge } from "../../components/page.tsx";
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBlock,
  cx,
  Field,
  FilterSelect,
  Progress,
  SectionTitle,
  Textarea,
} from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/datetime.ts";
import { formatPercent, prettyJson } from "../../lib/format.ts";
import { AGENT_EFFORT_OPTIONS, AGENT_MODEL_OPTIONS, PROFILE_STATUS } from "../../lib/labels.ts";
import { CancelJobButton, useLiveJobs } from "../../lib/live-jobs.tsx";
import {
  extractColorTokens,
  extractFontTokens,
  parseTokens,
  TOKEN_TEMPLATE,
} from "../../lib/profile.ts";
import { queryKeys } from "../../lib/query-keys.ts";

type Mode =
  | { kind: "view" }
  | { kind: "edit"; version: number }
  | { kind: "new"; from: BrandProfile | null };

/**
 * Brand profile versions (PLAN.md §6): view tokens / design rules / voice,
 * edit drafts, create a new draft from any version, trigger `brand.analyze`,
 * approve, see "current".
 */
export function ProfilesPanel({ brandId }: { brandId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { jobsById } = useLiveJobs();
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.profiles.all(brandId),
    queryFn: () =>
      fetchAllPages((cursor) => api.brandProfiles.list(brandId, { limit: 100, cursor })),
  });
  const profiles = query.data ?? [];
  const current = profiles.find((p) => p.isCurrent) ?? null;
  const fallback = current ?? profiles[0] ?? null;
  const profile = profiles.find((p) => p.version === selected) ?? fallback;

  useEffect(() => {
    setMode({ kind: "view" });
  }, [brandId]);

  const activeAnalyzeJob = [...jobsById.values()].find(
    (j) =>
      j.brandId === brandId &&
      j.type === "brand.analyze" &&
      (j.status === "queued" || j.status === "running"),
  );

  const approve = useMutation({
    mutationFn: (version: number) => api.brandProfiles.approve(brandId, version),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: queryKeys.profiles.all(brandId) });
      toast.success(`Sürüm ${p.version} onaylandı`, "Marka için güncel profil bu sürüm.");
      setConfirmApprove(false);
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle
        action={
          mode.kind === "view" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="accent"
                icon={<IconSparkle size={15} />}
                onClick={() => setAnalyzeOpen(true)}
              >
                AI ile analiz et
              </Button>
              {profiles.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<IconPlus size={16} />}
                  onClick={() => setMode({ kind: "new", from: profile })}
                >
                  Yeni sürüm
                </Button>
              )}
            </div>
          )
        }
      >
        Marka profili
      </SectionTitle>

      {activeAnalyzeJob && (
        <div className="mt-4 flex flex-col gap-2 rounded-2xl bg-surface-2 p-3.5 ring-1 ring-line">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-ink">
              {activeAnalyzeJob.progressMessage ?? "Marka profili analiz ediliyor…"}
            </span>
            <div className="flex items-center gap-2">
              {activeAnalyzeJob.progress !== undefined && (
                <span className="font-mono text-ink-2">
                  {formatPercent(activeAnalyzeJob.progress)}
                </span>
              )}
              <CancelJobButton job={activeAnalyzeJob} size="sm" />
            </div>
          </div>
          {activeAnalyzeJob.progress !== undefined && (
            <Progress value={activeAnalyzeJob.progress} label="Marka analizi ilerlemesi" />
          )}
        </div>
      )}

      {query.isPending ? (
        <SkeletonRows rows={3} className="mt-4" />
      ) : query.error ? (
        <div className="mt-4">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : profiles.length === 0 && mode.kind === "view" ? (
        <div className="mt-4">
          <EmptyState
            title="Profil henüz yok"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="accent"
                  icon={<IconSparkle size={18} />}
                  onClick={() => setAnalyzeOpen(true)}
                >
                  AI ile analiz et
                </Button>
                <Button
                  variant="primary"
                  icon={<IconPlus size={18} />}
                  onClick={() => setMode({ kind: "new", from: null })}
                >
                  İlk sürümü oluştur
                </Button>
              </div>
            }
          >
            Renkler, fontlar, tasarım kuralları (DESIGN.md) ve ses tonu (VOICE.md) burada
            sürümlenir. Onaylanmamış profil üretimde kullanılmaz.
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Version rail */}
          {profiles.length > 0 && (
            <fieldset className="mt-4 -mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1">
              <legend className="sr-only">Profil sürümleri</legend>
              {profiles.map((p) => {
                const active = p.version === profile?.version && mode.kind !== "new";
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelected(p.version);
                      setMode({ kind: "view" });
                    }}
                    className={cx(
                      "flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-left ring-1 ring-inset transition-colors",
                      active
                        ? "bg-ink text-bg ring-ink"
                        : "bg-surface ring-line hover:ring-line-strong",
                    )}
                  >
                    <span className="font-mono text-[13px] font-semibold">v{p.version}</span>
                    <span className={cx("text-[12px]", active ? "opacity-70" : "text-ink-3")}>
                      {p.isCurrent ? "Güncel" : PROFILE_STATUS[p.status].label}
                    </span>
                    {p.isCurrent && (
                      <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </fieldset>
          )}

          {mode.kind === "new" ? (
            <ProfileEditor
              key={`new-${mode.from?.version ?? 0}`}
              brandId={brandId}
              initial={mode.from}
              onDone={(saved) => {
                setMode({ kind: "view" });
                if (saved) setSelected(saved.version);
              }}
            />
          ) : mode.kind === "edit" && profile ? (
            <ProfileEditor
              key={`edit-${profile.version}`}
              brandId={brandId}
              initial={profile}
              editVersion={profile.version}
              onDone={() => setMode({ kind: "view" })}
            />
          ) : (
            profile && (
              <ProfileView
                profile={profile}
                onEdit={() => setMode({ kind: "edit", version: profile.version })}
                onApprove={() => setConfirmApprove(true)}
                onBranch={() => setMode({ kind: "new", from: profile })}
              />
            )
          )}
        </>
      )}

      {profile && (
        <ConfirmDialog
          open={confirmApprove}
          onClose={() => setConfirmApprove(false)}
          onConfirm={() => approve.mutate(profile.version)}
          loading={approve.isPending}
          title={
            profile.status === "approved"
              ? `Sürüm ${profile.version} güncel olsun mu?`
              : `Sürüm ${profile.version} onaylansın mı?`
          }
          message={
            profile.status === "approved"
              ? "Bu onaylı sürüm yeniden güncel profil olur (geri dönüş). Üretim bundan sonra bu sürümü kullanır."
              : "Onaylanan sürüm değiştirilemez ve marka için güncel profil olur. Üretim bundan sonra bu sürümü kullanır."
          }
          confirmLabel={profile.status === "approved" ? "Güncel yap" : "Onayla"}
        />
      )}

      <BrandAnalyzeDialog
        open={analyzeOpen}
        onClose={() => setAnalyzeOpen(false)}
        brandId={brandId}
      />
    </Card>
  );
}

function BrandAnalyzeDialog({
  open,
  onClose,
  brandId,
}: {
  open: boolean;
  onClose: () => void;
  brandId: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState("");
  const [sampleCaptions, setSampleCaptions] = useState("");
  const [includeFeedback, setIncludeFeedback] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [model, setModel] = useState<AgentModel | "">("");
  const [effort, setEffort] = useState<AgentEffort | "">("");

  useEffect(() => {
    if (!open) return;
    setNotes("");
    setSampleCaptions("");
    setIncludeFeedback(true);
    setAutoApprove(false);
  }, [open]);

  const analyze = useMutation({
    mutationFn: () => {
      const samplePosts = sampleCaptions
        .split(/\n{2,}/)
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 30)
        .map((caption) => ({ caption }));
      return api.jobs.create({
        type: "brand.analyze",
        brandId,
        payload: {
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          samplePosts,
          includeApprovedContentFeedback: includeFeedback,
          autoApprove,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success(
        "Marka analizi başlatıldı",
        "Mac worker postları ve notları inceleyip yeni bir profil taslağı oluşturacak.",
      );
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    analyze.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        analyze.reset();
        onClose();
      }}
      title="AI ile Marka Profili Çıkar"
      description="Geçmiş paylaşımlar, notlar ve onayladığınız tasarımlardan renk/font belirteçleri, DESIGN.md ve VOICE.md üretir."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="brand-analyze-form"
            variant="accent"
            icon={<IconSparkle size={16} />}
            loading={analyze.isPending}
          >
            Analizi başlat
          </Button>
        </>
      }
    >
      <form id="brand-analyze-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Marka notları ve yönlendirmeler"
          optional
          hint="Marka kimliği, renk tercihleri, rakiplerden farkı veya Figma notları."
        >
          {(p) => (
            <Textarea
              {...p}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="ör. Tarımsal bitki besleme markası; teknik açıdan güvenilir, abartısız Türkçe, koyu yeşil ve sıcak kağıt zemin…"
            />
          )}
        </Field>

        <Field
          label="Örnek paylaşım metinleri (isteğe bağlı)"
          optional
          hint="Her paylaşımı boş bir satırla ayırarak yapıştırabilirsiniz (LinkedIn dışa aktarımı veya Instagram postları)."
        >
          {(p) => (
            <Textarea
              {...p}
              value={sampleCaptions}
              onChange={(e) => setSampleCaptions(e.target.value)}
              rows={4}
              placeholder="Örnek post 1 metni…&#10;&#10;Örnek post 2 metni…"
            />
          )}
        </Field>

        <div className="flex flex-wrap gap-2">
          <FilterSelect
            label="Analiz modeli"
            value={model}
            onChange={(e) => setModel(e.target.value as AgentModel | "")}
          >
            <option value="">Varsayılan model</option>
            {AGENT_MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Çaba düzeyi"
            value={effort}
            onChange={(e) => setEffort(e.target.value as AgentEffort | "")}
          >
            <option value="">Varsayılan çaba</option>
            {AGENT_EFFORT_OPTIONS.map((ef) => (
              <option key={ef.value} value={ef.value}>
                {ef.label}
              </option>
            ))}
          </FilterSelect>
        </div>

        <Checkbox
          checked={includeFeedback}
          onChange={setIncludeFeedback}
          description="Daha önce onayladığınız içerikleri ve elle yaptığınız düzenlemeleri kurallara yansıtır."
        >
          Onaylanan içerik geri bildirimlerini dahil et
        </Checkbox>

        <Checkbox
          checked={autoApprove}
          onChange={setAutoApprove}
          description="Kapalıysa taslak oluşturulur; inceledikten sonra onaylarsınız."
        >
          Üretilen profili otomatik onayla
        </Checkbox>

        <InlineError error={analyze.error} />
      </form>
    </Dialog>
  );
}

function ProfileView({
  profile,
  onEdit,
  onApprove,
  onBranch,
}: {
  profile: BrandProfile;
  onEdit: () => void;
  onApprove: () => void;
  onBranch: () => void;
}) {
  const colors = extractColorTokens(profile.tokens);
  const fonts = extractFontTokens(profile.tokens);
  const draft = profile.status === "draft";

  return (
    <div className="mt-5 flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge meta={PROFILE_STATUS[profile.status]} />
        {profile.isCurrent && <Badge tone="accent">Güncel profil</Badge>}
        <span className="text-[12px] text-ink-3">
          {profile.approvedAt
            ? `Onay: ${formatDateTime(profile.approvedAt)}`
            : `Son düzenleme: ${formatDateTime(profile.updatedAt)}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {draft ? (
            <>
              <Button size="sm" variant="secondary" icon={<IconEdit size={16} />} onClick={onEdit}>
                Düzenle
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<IconCheck size={16} />}
                onClick={onApprove}
              >
                Onayla
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={onBranch}>
                Bu sürümden taslak
              </Button>
              {!profile.isCurrent && (
                <Button size="sm" variant="primary" onClick={onApprove}>
                  Güncel yap
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {(colors.length > 0 || fonts.length > 0) && (
        <div className="flex flex-col gap-4">
          {colors.length > 0 && (
            <ul
              className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6"
              aria-label="Renkler"
            >
              {colors.map((c) => (
                <li key={c.path} className="flex flex-col gap-1.5">
                  <span
                    className="aspect-[4/3] rounded-xl ring-1 ring-line-strong ring-inset"
                    style={{ background: c.value }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-[12px] font-medium text-ink" title={c.path}>
                    {c.path.split(".").pop()}
                  </span>
                  <span className="-mt-1 truncate font-mono text-[11px] text-ink-3">{c.value}</span>
                </li>
              ))}
            </ul>
          )}
          {fonts.length > 0 && (
            <ul
              className="flex flex-col divide-y divide-line rounded-xl ring-1 ring-line"
              aria-label="Fontlar"
            >
              {fonts.map((f) => (
                <li key={f.path} className="flex items-baseline justify-between gap-4 px-4 py-3">
                  <span
                    className="truncate text-[20px] text-ink"
                    style={{ fontFamily: `"${f.value}", var(--font-sans)` }}
                  >
                    {f.value}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-3">{f.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <TextSection
        title="Tasarım kuralları (DESIGN.md)"
        text={profile.designRules}
        empty="Tasarım kuralı yazılmamış."
      />
      <TextSection
        title="Ses tonu (VOICE.md)"
        text={profile.voice}
        empty="Ses tonu tanımlanmamış."
      />

      <details className="group">
        <summary className="text-[13px] font-medium text-ink-2 hover:text-ink">
          Belirteçler (JSON)
        </summary>
        <div className="mt-3">
          <CodeBlock label="Belirteçler">{prettyJson(profile.tokens)}</CodeBlock>
        </div>
      </details>
    </div>
  );
}

function TextSection({ title, text, empty }: { title: string; text: string; empty: string }) {
  return (
    <section>
      <h3 className="mb-2 font-display text-[22px] text-ink">{title}</h3>
      {text.trim() ? (
        <div className="max-h-80 overflow-y-auto rounded-xl bg-surface-2 p-4 text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
          {text}
        </div>
      ) : (
        <p className="text-sm text-ink-3">{empty}</p>
      )}
    </section>
  );
}

function ProfileEditor({
  brandId,
  initial,
  editVersion,
  onDone,
}: {
  brandId: string;
  initial: BrandProfile | null;
  /** Edit this draft in place; otherwise create a new version. */
  editVersion?: number;
  onDone: (saved?: BrandProfile) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [tokensText, setTokensText] = useState(() => prettyJson(initial?.tokens ?? TOKEN_TEMPLATE));
  const [designRules, setDesignRules] = useState(initial?.designRules ?? "");
  const [voice, setVoice] = useState(initial?.voice ?? "");
  const parsed = parseTokens(tokensText);

  const save = useMutation({
    mutationFn: () => {
      if (!parsed.ok) throw new Error(parsed.error);
      const input = { tokens: parsed.value, designRules, voice };
      return editVersion !== undefined
        ? api.brandProfiles.update(brandId, editVersion, input)
        : api.brandProfiles.create(brandId, input);
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: queryKeys.profiles.all(brandId) });
      toast.success(
        editVersion !== undefined
          ? `Sürüm ${p.version} kaydedildi`
          : `Taslak sürüm ${p.version} oluşturuldu`,
      );
      onDone(p);
    },
  });

  return (
    <form
      className="mt-5 flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-sm text-ink-2">
        {editVersion !== undefined
          ? `Taslak sürüm ${editVersion} düzenleniyor.`
          : initial
            ? `Sürüm ${initial.version} temel alınarak yeni bir taslak oluşturuluyor. Onaylanana kadar kullanılmaz.`
            : "İlk profil sürümü. Onaylanana kadar üretimde kullanılmaz."}
      </p>
      <Field
        label="Belirteçler (brand.json)"
        error={parsed.ok ? null : parsed.error}
        hint="Renkler, fontlar, boşluk, köşe yarıçapı, ızgara."
      >
        {(p) => (
          <Textarea
            {...p}
            value={tokensText}
            onChange={(e) => setTokensText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="font-mono text-[13px]"
          />
        )}
      </Field>
      <Field
        label="Tasarım kuralları (DESIGN.md)"
        hint="Yerleşim kalıpları, tipografik hiyerarşi, yapılacaklar / yapılmayacaklar."
      >
        {(p) => (
          <Textarea
            {...p}
            value={designRules}
            onChange={(e) => setDesignRules(e.target.value)}
            rows={8}
          />
        )}
      </Field>
      <Field
        label="Ses tonu (VOICE.md)"
        hint="Ton, kelime dağarcığı, emoji ve hashtag alışkanlığı, örnek metinler."
      >
        {(p) => (
          <Textarea {...p} value={voice} onChange={(e) => setVoice(e.target.value)} rows={8} />
        )}
      </Field>
      <InlineError error={save.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()}>
          Vazgeç
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!parsed.ok}>
          {editVersion !== undefined ? "Taslağı kaydet" : "Taslak oluştur"}
        </Button>
      </div>
    </form>
  );
}
