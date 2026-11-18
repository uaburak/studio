// "Planlar" (N2): the month plans of the brand (or every brand) on the left, the open plan on the
// right — item by item: date, type, topic, where it stands, the post's picture, and Üret / Yeniden
// dene / Yeniden üret; "Bekleyenleri üret" and "Yalnızca başarısızları üret" for the plan; items
// edited, added and removed in place (`plans.updateItem / addItem / removeItem`). Generating more
// than a handful of posts shows the time / cost estimate first (N4).
import {
  ApiError,
  type Content,
  type GenerationEstimateQuery,
  type Plan,
  type PlanGenerate,
  type PlanItem,
  type Platform,
} from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  SegmentedControl,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog.tsx";
import { IconPencil, IconPlus, IconTrash } from "../../components/ui/icons.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { useAppStore } from "../../state/app-store.ts";
import { TemplateSelect } from "../brand/template-select.tsx";
import { DayLabels, SimilarMark } from "../calendar/special-day-views.tsx";
import { useSpecialDays } from "../calendar/special-days-data.ts";
import {
  dayLabelTitle,
  labelsByDay,
  marksOf,
  planSpecialDays,
} from "../calendar/special-days-model.ts";
import { CONTENT_TYPE_LABEL, PLATFORM_LABEL } from "./board.ts";
import { useContents, useCurrentVersions, usePlans } from "./data.ts";
import { localDate, shortDay } from "./dates.ts";
import { EstimateDialog, needsEstimate } from "./estimate.tsx";
import {
  CONTENT_TYPES,
  draftError,
  draftOf,
  draftPatch,
  failedItemIds,
  generateSummary,
  ITEM_ACTION_LABEL,
  ITEM_STATE_LABEL,
  ITEM_STATE_TONE,
  type ItemDraft,
  imageSlotsOf,
  itemAction,
  itemFailure,
  itemState,
  newItemDraft,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_TONE,
  planCounts,
  planGroups,
  planTitle,
} from "./plan-model.ts";
import { coverAssetId } from "./post-media.tsx";
import { openPostDetail, usePostsStore } from "./store.ts";

const PLATFORMS: Platform[] = ["instagram", "facebook", "linkedin"];

export function PlansView({
  brandId,
  brandName,
}: {
  /** null: every brand. */
  brandId: string | null;
  brandName(id: string): string | undefined;
}) {
  const plans = usePlans(brandId);
  const contents = useContents(brandId);
  const planId = usePostsStore((s) => s.planId);
  const groups = useMemo(() => planGroups(plans.data ?? []), [plans.data]);
  const all = useMemo(() => groups.flatMap((g) => g.plans), [groups]);
  const open =
    all.find((p) => p.id === planId) ??
    all.find((p) => p.status === "accepted" || p.status === "proposed") ??
    all[0] ??
    null;
  const byId = useMemo(() => new Map((contents.data ?? []).map((c) => [c.id, c])), [contents.data]);
  const contentOf = (id: string | null): Content | null | undefined => {
    if (!id) return null;
    if (!contents.data) return undefined;
    return byId.get(id) ?? null;
  };

  if (plans.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
        <Spinner /> Planlar yükleniyor…
      </div>
    );
  }
  if (plans.error) {
    return <p className="px-8 text-body text-danger">{describeError(plans.error)}</p>;
  }
  if (all.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-24 text-center">
        <p className="text-heading font-semibold text-fg">Henüz plan yok</p>
        <p className="max-w-[420px] text-body text-fg-2">
          Sohbette bir ay için post planı iste; onayladığın planlar burada madde madde görünür.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 gap-6 px-8 pb-8">
      <nav aria-label="Planlar" className="scroll-area w-[260px] shrink-0">
        {groups.map((group) => (
          <section key={group.month} className="mb-4">
            <h3 className="mb-1.5 text-footnote font-medium text-fg-3">{group.title}</h3>
            <ul className="flex flex-col gap-1">
              {group.plans.map((plan) => {
                const counts = planCounts(plan, contentOf);
                return (
                  <li key={plan.id}>
                    <button
                      type="button"
                      aria-current={plan.id === open?.id || undefined}
                      onClick={() => usePostsStore.getState().showPlan(plan.id)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-[10px] px-3 py-2 text-left hover:bg-control",
                        plan.id === open?.id && "bg-control",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
                          {planTitle(plan)}
                        </span>
                        <TagPill tone={PLAN_STATUS_TONE[plan.status]}>
                          {PLAN_STATUS_LABEL[plan.status]}
                        </TagPill>
                      </span>
                      <span className="truncate text-footnote text-fg-2">
                        {brandId === null ? `${brandName(plan.brandId) ?? "Marka"} · ` : ""}
                        {counts.total} post
                        {counts.done > 0 ? ` · ${counts.done} hazır` : ""}
                        {counts.failed > 0 ? ` · ${counts.failed} başarısız` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      {open && <PlanDetail key={open.id} plan={open} contentOf={contentOf} />}
    </div>
  );
}

function PlanDetail({
  plan,
  contentOf,
}: {
  plan: Plan;
  contentOf(id: string | null): Content | null | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<{
    query: GenerationEstimateQuery;
    what: string;
    run: () => Promise<void>;
  } | null>(null);
  const [editing, setEditing] = useState<PlanItem | "new" | null>(null);
  const [removing, setRemoving] = useState<PlanItem | null>(null);
  const [regenerate, setRegenerate] = useState<{ item: PlanItem; overwrite: string | null } | null>(
    null,
  );
  const items = plan.items.filter((i) => i.status !== "skipped");
  const counts = planCounts(plan, contentOf);
  const failed = failedItemIds(plan, contentOf);
  const linked = useMemo(
    () => items.flatMap((i) => contentOf(i.contentId) ?? []).filter((c) => c.currentVersion),
    [items, contentOf],
  );
  const versions = useCurrentVersions(linked);
  const editable =
    plan.status === "draft" || plan.status === "proposed" || plan.status === "accepted";
  // The period's special days for the brand (N5): above the items and next to their dates.
  const special = useSpecialDays(plan.brandId, plan.periodStart, plan.periodEnd);
  const labels = useMemo(() => labelsByDay(special.days), [special.days]);
  const periodDays = planSpecialDays(special.days);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["posts"] }),
      queryClient.invalidateQueries({ queryKey: ["calendar"] }),
    ]);
  };

  const generate = async (input: PlanGenerate): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.plans.generate(plan.id, input);
      toast({ message: generateSummary(result.jobs.length, result.skipped) });
      await refresh();
    } catch (e) {
      toast({ message: describeError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  /** Runs `run` at once, or after the estimate when `count` posts are many. */
  const withEstimate = (count: number, slots: number, what: string, run: () => Promise<void>) => {
    if (!needsEstimate(count)) return void run();
    setEstimate({ query: { count, brandId: plan.brandId, imageSlots: slots }, what, run });
  };

  const acceptAndGenerate = () =>
    withEstimate(
      items.length,
      imageSlotsOf(items),
      `${items.length} post üretilecek.`,
      async () => {
        setBusy(true);
        try {
          const accepted =
            plan.status === "accepted"
              ? plan
              : await api.plans.accept(plan.id, { revision: plan.revision });
          const result = await api.plans.generate(accepted.id, {});
          toast({ message: generateSummary(result.jobs.length, result.skipped) });
          await refresh();
        } catch (e) {
          toast({ message: describeError(e), tone: "danger" });
        } finally {
          setBusy(false);
        }
      },
    );

  const pendingCount = counts.pending + counts.failed;
  const pendingItems = items.filter((i) => {
    const s = itemState(i, contentOf(i.contentId));
    return s === "pending" || s === "failed";
  });

  const runItem = (item: PlanItem) => {
    const state = itemState(item, contentOf(item.contentId));
    const action = itemAction(state);
    if (action === "generate" || action === "retry") void generate({ itemIds: [item.id] });
    else if (action === "regenerate") setRegenerate({ item, overwrite: null });
  };

  const forceRegenerate = async (item: PlanItem, overwrite: boolean) => {
    setBusy(true);
    try {
      const result = await api.plans.generate(plan.id, {
        itemIds: [item.id],
        force: true,
        ...(overwrite ? { overwriteEdits: true } : {}),
      });
      toast({ message: generateSummary(result.jobs.length, result.skipped) });
      setRegenerate(null);
      await refresh();
    } catch (e) {
      // An edited or approved post needs a second yes (the API says why).
      if (!overwrite && e instanceof ApiError && e.status === 409) {
        const status = contentOf(item.contentId)?.status;
        setRegenerate({
          item,
          overwrite:
            status === "approved" || status === "scheduled"
              ? "Bu post onaylı ya da zamanlanmış."
              : "Bu post elle ya da yapay zekâyla düzenlenmiş.",
        });
      } else {
        toast({ message: describeError(e), tone: "danger" });
        setRegenerate(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={planTitle(plan)} className="scroll-area flex min-w-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-heading font-semibold text-fg">
            <span className="truncate">{planTitle(plan)}</span>
            <TagPill tone={PLAN_STATUS_TONE[plan.status]}>{PLAN_STATUS_LABEL[plan.status]}</TagPill>
          </h2>
          <p className="text-footnote text-fg-2">
            {shortDay(localDate(plan.periodStart) ?? new Date())} –{" "}
            {shortDay(localDate(plan.periodEnd) ?? new Date())} · {counts.total} post
            {counts.generating > 0 ? ` · ${counts.generating} üretiliyor` : ""}
            {counts.failed > 0 ? ` · ${counts.failed} başarısız` : ""}
          </p>
          {periodDays.length > 0 && (
            <ul
              aria-label="Dönemin özel günleri"
              className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-fg-2"
            >
              {periodDays.map((d) => (
                <li key={d.id} title={dayLabelTitle(d, d.date)}>
                  <span className="text-fg-3">{shortDay(localDate(d.date) ?? new Date())}</span>{" "}
                  {d.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(plan.status === "proposed" || plan.status === "draft") && (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.plans.reject(plan.id, {});
                    await refresh();
                  } catch (e) {
                    toast({ message: describeError(e), tone: "danger" });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Reddet
              </Button>
              <Button variant="primary" disabled={busy} onClick={acceptAndGenerate}>
                Onayla ve üret
              </Button>
            </>
          )}
          {plan.status === "accepted" && failed.length > 0 && (
            <Button
              disabled={busy}
              onClick={() =>
                withEstimate(
                  failed.length,
                  imageSlotsOf(items.filter((i) => failed.includes(i.id))),
                  `${failed.length} başarısız post yeniden üretilecek.`,
                  () => generate({ itemIds: failed }),
                )
              }
            >
              Yalnızca başarısızları üret ({failed.length})
            </Button>
          )}
          {plan.status === "accepted" && pendingCount > 0 && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                withEstimate(
                  pendingCount,
                  imageSlotsOf(pendingItems),
                  `${pendingCount} post üretilecek (üretilmiş ve düzenlenmiş postlara dokunulmaz).`,
                  () => generate({}),
                )
              }
            >
              Bekleyenleri üret ({pendingCount})
            </Button>
          )}
          {editable && (
            <Button
              icon={<IconPlus size={14} strokeWidth={2} />}
              disabled={busy}
              onClick={() => setEditing("new")}
            >
              Kalem ekle
            </Button>
          )}
        </div>
      </div>
      <table className="w-full table-fixed border-collapse text-body">
        <thead>
          <tr className="border-b border-hairline text-left text-footnote text-fg-3">
            <th className="w-[92px] py-2 font-normal">Tarih</th>
            <th className="w-[96px] py-2 font-normal">Tür</th>
            <th className="py-2 font-normal">Konu</th>
            <th className="w-[150px] py-2 font-normal">Durum</th>
            <th className="w-[52px] py-2 font-normal">
              <span className="sr-only">Görsel</span>
            </th>
            <th className="w-[200px] py-2 font-normal">
              <span className="sr-only">İşlemler</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const content = contentOf(item.contentId);
            const state = itemState(item, content);
            const failure = itemFailure(item, state);
            const action = itemAction(state);
            const version = content ? (versions.get(content.id) ?? null) : null;
            const cover = coverAssetId(version, item.contentType === "reel");
            return (
              <tr key={item.id} className="border-b border-hairline align-top">
                <td className="py-2.5 pr-1 text-fg-2">
                  {item.date ? shortDay(localDate(item.date) ?? new Date()) : "—"}
                  {item.date && <DayLabels labels={labels.get(item.date) ?? []} max={1} />}
                </td>
                <td className="py-2.5 text-fg-2">{CONTENT_TYPE_LABEL[item.contentType]}</td>
                <td className="py-2.5 pr-3">
                  <div className="truncate font-medium text-fg">{item.title}</div>
                  {item.brief && (
                    <div className="line-clamp-2 text-footnote text-fg-2">{item.brief}</div>
                  )}
                  {marksOf(item).length > 0 && (
                    <div className="mt-1">
                      <SimilarMark item={item} />
                    </div>
                  )}
                </td>
                <td className="py-2.5 pr-2">
                  <span className="flex items-center gap-1.5">
                    {state === "generating" && <Spinner size={11} />}
                    <TagPill tone={ITEM_STATE_TONE[state]}>{ITEM_STATE_LABEL[state]}</TagPill>
                  </span>
                  {failure && (
                    <div
                      className="mt-1 line-clamp-2 text-footnote text-danger"
                      title={item.generation?.error ?? undefined}
                    >
                      {failure}
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {cover ? (
                    <button
                      type="button"
                      aria-label={`Postu aç: ${item.title}`}
                      onClick={() => content && openPostDetail(content.id)}
                      className="block h-[50px] w-[40px] overflow-hidden rounded-[6px] bg-control"
                    >
                      <img
                        src={thumbUrl(cover, 40)}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    </button>
                  ) : (
                    <span className="block h-[50px] w-[40px] rounded-[6px] bg-control" />
                  )}
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {action && plan.status === "accepted" && (
                      <Button
                        variant={action === "regenerate" ? "ghost" : "secondary"}
                        disabled={busy}
                        onClick={() => runItem(item)}
                      >
                        {ITEM_ACTION_LABEL[action]}
                      </Button>
                    )}
                    {content && (
                      <Button variant="ghost" onClick={() => openPostDetail(content.id)}>
                        Postu aç
                      </Button>
                    )}
                    {editable && (
                      <>
                        <button
                          type="button"
                          aria-label={`Düzenle: ${item.title}`}
                          title="Düzenle"
                          disabled={busy}
                          onClick={() => setEditing(item)}
                          className="flex size-7 items-center justify-center rounded-full text-icon hover:bg-control"
                        >
                          <IconPencil size={14} strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Sil: ${item.title}`}
                          title="Plandan çıkar"
                          disabled={busy}
                          onClick={() => setRemoving(item)}
                          className="flex size-7 items-center justify-center rounded-full text-icon hover:bg-control"
                        >
                          <IconTrash size={14} strokeWidth={1.75} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ItemDialog
        plan={plan}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `“${removing.title}” plandan çıkarılsın mı?` : ""}
        message="Tasarımı olmayan taslak postu Silinenler'e taşınır; tasarımı olan post Postlar'da kalır."
        confirmLabel="Plandan çıkar"
        destructive
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try {
            const result = await api.plans.removeItem(plan.id, removing.id);
            toast({
              message: result.trashedContentId
                ? `“${removing.title}” plandan çıkarıldı; taslağı Silinenler'de.`
                : `“${removing.title}” plandan çıkarıldı.`,
            });
            await refresh();
          } catch (e) {
            toast({ message: describeError(e), tone: "danger" });
          } finally {
            setBusy(false);
            setRemoving(null);
          }
        }}
      />
      <ConfirmDialog
        open={regenerate !== null}
        title={regenerate ? `“${regenerate.item.title}” yeniden üretilsin mi?` : ""}
        message={
          regenerate?.overwrite
            ? `${regenerate.overwrite} Yeniden üretmek bu düzenlemelerin yerine yeni bir tasarım koyar (eski sürüm geçmişte kalır); onaylıysa onayı kalkar, zamanlamaları iptal edilir.`
            : "Postun yerine yeni bir tasarım üretilir; şimdiki sürüm Sürümler'de kalır."
        }
        confirmLabel={regenerate?.overwrite ? "Yine de yeniden üret" : "Yeniden üret"}
        destructive={!!regenerate?.overwrite}
        busy={busy}
        onClose={() => setRegenerate(null)}
        onConfirm={() => {
          if (regenerate) void forceRegenerate(regenerate.item, regenerate.overwrite !== null);
        }}
      />
      <EstimateDialog
        query={estimate?.query ?? null}
        title="Üretim başlasın mı?"
        what={estimate?.what ?? ""}
        onClose={() => setEstimate(null)}
        onConfirm={async () => {
          const run = estimate?.run;
          setEstimate(null);
          await run?.();
        }}
      />
    </section>
  );
}

function ItemDialog({
  plan,
  editing,
  onClose,
  onSaved,
}: {
  plan: Plan;
  editing: PlanItem | "new" | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const api = useApi();
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openedFor, setOpenedFor] = useState<PlanItem | "new" | null>(null);
  if (editing !== openedFor) {
    setOpenedFor(editing);
    setDraft(editing === null ? null : editing === "new" ? newItemDraft(plan) : draftOf(editing));
    setError(null);
  }
  const problem = draft ? draftError(draft, plan) : null;
  const update = (patch: Partial<ItemDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const save = async () => {
    if (!draft || problem || !editing) return;
    setSaving(true);
    setError(null);
    try {
      if (editing === "new") {
        await api.plans.addItem(plan.id, {
          date: draft.date || null,
          contentType: draft.contentType,
          title: draft.title.trim(),
          brief: draft.brief,
          hook: draft.hook.trim() || null,
          platforms: draft.platforms,
          ...(draft.templateId ? { templateId: draft.templateId } : {}),
        });
      } else {
        const patch = draftPatch(editing, draft);
        if (Object.keys(patch).length > 0) await api.plans.updateItem(plan.id, editing.id, patch);
      }
      await onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={editing !== null && draft !== null}
      title={editing === "new" ? "Kalem ekle" : "Kalemi düzenle"}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !!problem}>
            {saving ? "Kaydediliyor…" : "Kaydet"}
          </Button>
        </>
      }
    >
      {draft && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-footnote text-fg-2">Tarih</span>
            <TextField
              type="date"
              aria-label="Tarih"
              value={draft.date}
              min={plan.periodStart}
              max={plan.periodEnd}
              onChange={(e) => update({ date: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-footnote text-fg-2">Tür</span>
            <SegmentedControl
              label="Tür"
              value={draft.contentType}
              // A template is of one type: another type is designed anew.
              onChange={(contentType) => update({ contentType, templateId: null })}
              options={CONTENT_TYPES}
            />
          </div>
          <TemplateSelect
            brandId={plan.brandId}
            contentType={draft.contentType}
            value={draft.templateId ?? null}
            onChange={(templateId) => update({ templateId })}
          />
          <div className="flex flex-col gap-1">
            <span className="text-footnote text-fg-2">Konu</span>
            <TextField
              aria-label="Konu"
              value={draft.title}
              maxLength={200}
              onChange={(e) => update({ title: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-footnote text-fg-2">Açılış cümlesi (kanca)</span>
            <TextField
              aria-label="Açılış cümlesi (kanca)"
              placeholder="Postun ilk cümlesi; önceki postlardan farklı olsun"
              value={draft.hook}
              maxLength={300}
              onChange={(e) => update({ hook: e.target.value })}
            />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-footnote text-fg-2">Brief</span>
            <textarea
              aria-label="Brief"
              value={draft.brief}
              rows={4}
              onChange={(e) => update({ brief: e.target.value })}
              className="selectable resize-y rounded-[10px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none"
            />
          </label>
          <div className="flex flex-wrap items-center gap-4">
            {PLATFORMS.map((p) => (
              <Checkbox
                key={p}
                checked={draft.platforms.includes(p)}
                onChange={(on) =>
                  update({
                    platforms: on
                      ? [...draft.platforms, p]
                      : draft.platforms.filter((x) => x !== p),
                  })
                }
              >
                {PLATFORM_LABEL[p]}
              </Checkbox>
            ))}
          </div>
          {(error ?? problem) && <p className="text-footnote text-danger">{error ?? problem}</p>}
        </div>
      )}
    </Dialog>
  );
}
