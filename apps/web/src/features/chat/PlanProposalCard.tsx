import {
  type AgentEffort,
  type AgentModel,
  isPlanEditable,
  type Plan,
  type PlanItem,
} from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api.ts";
import { IconCheck, IconEdit, IconPlatform, IconSparkle } from "../../components/icons.tsx";
import { StatusBadge } from "../../components/page.tsx";
import { InlineError } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Input,
  Mono,
  Spinner,
  Tag,
  Textarea,
} from "../../components/ui.tsx";
import {
  CONTENT_TYPE_LABELS,
  IMAGE_SLOT_LABELS,
  JOB_STATUS,
  PLAN_STATUS,
  PLATFORM_LABELS,
} from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";

export function PlanProposalCard({
  planId,
  cachedPlan,
  selectedModel,
  selectedEffort,
  onPlanUpdated,
}: {
  planId: string;
  cachedPlan?: Plan | undefined;
  selectedModel?: AgentModel | undefined;
  selectedEffort?: AgentEffort | undefined;
  onPlanUpdated?: (plan: Plan) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();

  const planQuery = useQuery({
    queryKey: queryKeys.plans.one(planId),
    queryFn: ({ signal }) => api.plans.get(planId, { signal }),
    enabled: !cachedPlan,
    ...(cachedPlan ? { initialData: cachedPlan } : {}),
  });

  const plan = cachedPlan ?? planQuery.data;
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [genInstructions, setGenInstructions] = useState("");

  useEffect(() => {
    if (plan && !editing) {
      setDraftTitle(plan.title);
      setDraftSummary(plan.summary);
    }
  }, [plan, editing]);

  const syncPlan = (updated: Plan) => {
    qc.setQueryData(queryKeys.plans.one(updated.id), updated);
    void qc.invalidateQueries({ queryKey: queryKeys.plans.all });
    void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
    void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
    onPlanUpdated?.(updated);
  };

  const acceptOnly = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Plan yüklenmedi");
      return api.plans.accept(plan.id, {
        revision: plan.revision,
        skipItemIds: [...skippedIds],
      });
    },
    onSuccess: (updated) => {
      syncPlan(updated);
      toast.success("Plan kabul edildi", "Taslak içerikler oluşturuldu.");
    },
    onError: (e) => toast.error(e, "Plan kabul edilemedi"),
  });

  const acceptAndGenerate = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Plan yüklenmedi");
      const accepted =
        plan.status === "accepted"
          ? plan
          : await api.plans.accept(plan.id, {
              revision: plan.revision,
              skipItemIds: [...skippedIds],
            });
      const generated = await api.plans.generate(accepted.id, {
        ...(genInstructions.trim() ? { instructions: genInstructions.trim() } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
      return generated;
    },
    onSuccess: ({ plan: updated, jobs }) => {
      syncPlan(updated);
      toast.success(
        "Plan kabul edildi ve üretim başlatıldı",
        `${jobs.length} içerik üretim kuyruğuna eklendi.`,
      );
    },
    onError: (e) => toast.error(e, "Üretim başlatılamadı"),
  });

  const generateAccepted = useMutation({
    mutationFn: async (itemIds?: string[]) => {
      if (!plan) throw new Error("Plan yüklenmedi");
      return api.plans.generate(plan.id, {
        ...(itemIds && itemIds.length > 0 ? { itemIds } : {}),
        ...(genInstructions.trim() ? { instructions: genInstructions.trim() } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
    },
    onSuccess: ({ plan: updated, jobs }) => {
      syncPlan(updated);
      toast.success(`${jobs.length} içerik için üretim kuyruğa alındı`);
    },
    onError: (e) => toast.error(e, "Üretim başlatılamadı"),
  });

  const rejectPlan = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Plan yüklenmedi");
      return api.plans.reject(plan.id, {});
    },
    onSuccess: (updated) => {
      syncPlan(updated);
      toast.success("Plan reddedildi");
    },
    onError: (e) => toast.error(e, "Plan reddedilemedi"),
  });

  const saveEdit = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Plan yüklenmedi");
      return api.plans.update(plan.id, {
        revision: plan.revision,
        title: draftTitle.trim(),
        summary: draftSummary,
      });
    },
    onSuccess: (updated) => {
      syncPlan(updated);
      setEditing(false);
      toast.success("Plan güncellendi");
    },
    onError: (e) => toast.error(e, "Plan güncellenemedi"),
  });

  if (!plan) {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-surface-2 p-4 text-sm text-ink-2">
        <Spinner size={16} /> Plan yükleniyor…
      </div>
    );
  }

  const editable = isPlanEditable(plan.status);
  const toggleSkip = (itemId: string) => {
    setSkippedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const activeItemsCount = plan.items.length - skippedIds.size;
  const error =
    acceptAndGenerate.error ??
    acceptOnly.error ??
    generateAccepted.error ??
    rejectPlan.error ??
    saveEdit.error;

  return (
    <Card className="my-2 overflow-hidden border border-line-strong bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge meta={PLAN_STATUS[plan.status]} />
            <Mono className="text-ink-3">
              {plan.periodStart} → {plan.periodEnd}
            </Mono>
            <Tag>rev {plan.revision}</Tag>
            <Tag>{plan.items.length} içerik</Tag>
          </div>
          {!editing && (
            <h4 className="mt-2 font-display text-2xl leading-tight text-ink">
              {plan.title || "İçerik Planı"}
            </h4>
          )}
        </div>
        {editable && !editing && (
          <Button
            size="sm"
            variant="ghost"
            icon={<IconEdit size={15} />}
            onClick={() => setEditing(true)}
          >
            Düzenle
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
          <Input
            aria-label="Plan başlığı"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Plan başlığı"
          />
          <Textarea
            aria-label="Plan özeti"
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            rows={3}
            placeholder="Plan özeti"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={saveEdit.isPending}
              onClick={() => saveEdit.mutate()}
            >
              Kaydet
            </Button>
          </div>
        </div>
      ) : (
        plan.summary && <p className="mt-2 text-sm leading-relaxed text-ink-2">{plan.summary}</p>
      )}

      <ul className="mt-4 flex flex-col gap-2">
        {plan.items.map((item) => (
          <PlanItemRow
            key={item.id}
            item={item}
            selectable={editable}
            included={!skippedIds.has(item.id)}
            onToggle={() => toggleSkip(item.id)}
          />
        ))}
      </ul>

      {(editable || plan.status === "accepted") && (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
          <Input
            aria-label="Üretim ek talimatı"
            value={genInstructions}
            onChange={(e) => setGenInstructions(e.target.value)}
            placeholder="Üretim için ek talimat (isteğe bağlı)…"
            className="h-9 text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {editable ? (
              <>
                <span className="text-xs text-ink-3">
                  {activeItemsCount} / {plan.items.length} içerik seçili
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={rejectPlan.isPending}
                    onClick={() => rejectPlan.mutate()}
                  >
                    Reddet
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconCheck size={15} />}
                    loading={acceptOnly.isPending}
                    disabled={activeItemsCount === 0}
                    onClick={() => acceptOnly.mutate()}
                  >
                    Yalnızca kabul et
                  </Button>
                  <Button
                    size="sm"
                    variant="accent"
                    icon={<IconSparkle size={15} />}
                    loading={acceptAndGenerate.isPending}
                    disabled={activeItemsCount === 0}
                    onClick={() => acceptAndGenerate.mutate()}
                  >
                    Kabul et ve üret
                  </Button>
                </div>
              </>
            ) : (
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="accent"
                  icon={<IconSparkle size={15} />}
                  loading={generateAccepted.isPending}
                  onClick={() => generateAccepted.mutate(undefined)}
                >
                  Kalanları üret
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {error ? (
        <div className="mt-3">
          <InlineError error={error} />
        </div>
      ) : null}
    </Card>
  );
}

function PlanItemRow({
  item,
  selectable,
  included,
  onToggle,
}: {
  item: PlanItem;
  selectable: boolean;
  included: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cx(
        "flex items-start gap-3 rounded-xl p-3 ring-1 ring-inset ring-line transition-opacity",
        (!included || item.status === "skipped") && "opacity-55",
      )}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={included}
          onChange={onToggle}
          aria-label={`${item.title} dahil et`}
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.date && <Mono className="text-ink-3">{item.date}</Mono>}
          <Tag>{CONTENT_TYPE_LABELS[item.contentType]}</Tag>
          {item.pillar && <Tag>{item.pillar}</Tag>}
          {item.imageSlot !== "none" && (
            <Badge tone="info" dot={false}>
              {IMAGE_SLOT_LABELS[item.imageSlot]}
            </Badge>
          )}
          <span className="flex items-center gap-1 text-ink-3">
            {item.platforms.map((p) => (
              <span key={p} title={PLATFORM_LABELS[p]}>
                <IconPlatform platform={p} size={14} />
              </span>
            ))}
          </span>
          {item.generation && (
            <StatusBadge meta={JOB_STATUS[item.generation.status]} className="ml-auto" />
          )}
        </div>
        <p className="mt-1 text-sm font-medium text-ink">{item.title}</p>
        {item.brief && <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{item.brief}</p>}
        {item.contentId && (
          <Link
            to={`/icerikler/${item.contentId}`}
            className="mt-1.5 inline-flex text-xs font-medium text-accent hover:underline"
          >
            İçeriği aç →
          </Link>
        )}
      </div>
    </li>
  );
}
