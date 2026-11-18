// The bulk bar of the posts board (N1): shown while cards are picked (⌘-click, ⇧-click,
// "Tümünü seç"). Onayla (through the checks gate: blocked posts are listed, "yalnızca sorunsuzları
// onayla" / "yine de hepsini onayla"), Zamanla (one time per post over the chosen days, or each
// post's planned day), Talimat uygula (N3, with the estimate for many posts: N4), Dönüştür (story
// or Reels from each post, N10), Çoğalt and Sil (to the trash, with "Geri al").
import type { SocialAccount } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, Checkbox, cn, SegmentedControl, Spinner } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { IconClose } from "../../components/ui/icons.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useAccounts, useJobsSnapshot } from "../../state/studio.tsx";
import { type ApprovalGate, awaitApprovalGate } from "../checks/approval-gate.ts";
import { dateError, submitSchedule } from "../post-detail/schedule.ts";
import { approvableHash, type PostCard } from "./board.ts";
import {
  approvable,
  approvalLosses,
  bulkAccounts,
  deletable,
  type Excluded,
  mapLimit,
  revisable,
  type SpreadMode,
  schedulable,
  spreadTimes,
} from "./bulk.ts";
import { ConvertDialog } from "./convert-dialog.tsx";
import { invalidatePosts } from "./data.ts";
import { dateInput, shortDayTime } from "./dates.ts";
import { EstimateDialog, needsEstimate } from "./estimate.tsx";
import { usePostsStore } from "./store.ts";
import { toast, trashPosts, UNDO_TOAST_MS } from "./trash.ts";

type Gated = { card: PostCard; hash: string | null; gate: ApprovalGate };

export function BulkBar({
  picked,
  visibleCount,
  onSelectAll,
}: {
  /** The picked cards that are visible, in board order. */
  picked: PostCard[];
  visibleCount: number;
  onSelectAll(): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const presence = useJobsSnapshot().presence;
  const [busy, setBusy] = useState<string | null>(null);
  const [gated, setGated] = useState<{ checked: Gated[]; skipped: Excluded[] } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [revising, setRevising] = useState(false);
  const [converting, setConverting] = useState(false);
  const clear = () => usePostsStore.getState().clearPicked();

  const approveAll = async (list: Gated[], acknowledge: boolean) => {
    setBusy("Onaylanıyor…");
    const results = await mapLimit(list, 4, ({ card, hash }) =>
      api.contents.approve(
        card.id,
        acknowledge ? { hash: hash as string, acknowledgeChecks: true } : (hash as string),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    await invalidatePosts(queryClient);
    setBusy(null);
    setGated(null);
    toast({ message: `${ok} post onaylandı.` });
    if (failed) toast({ message: describeError(failed.reason), tone: "danger" });
    if (ok > 0) clear();
  };

  const approve = async () => {
    const { take, skip } = approvable(picked);
    if (take.length === 0) {
      toast({
        message: skip[0] ? `Onaylanacak post yok: ${skip[0].reason}` : "Onaylanacak post yok.",
      });
      return;
    }
    let done = 0;
    setBusy(`Kontroller okunuyor… 0/${take.length}`);
    const results = await mapLimit(take, 4, async (card): Promise<Gated> => {
      const ref = card.content.currentVersion;
      const version =
        card.version ?? (ref ? await api.contents.versions.get(card.id, ref.version) : null);
      const hash = await approvableHash(card.content, version);
      const gate: ApprovalGate =
        !version || !hash
          ? {
              kind: "unfinished",
              version: ref?.version ?? 0,
              reason: "Sürüm doğrulanamadı; postu açıp yenile.",
            }
          : await awaitApprovalGate(
              api,
              card.content,
              { version: version.version, id: version.id },
              { timeoutMs: 15_000, workerOnline: () => presence?.online ?? false },
            );
      done += 1;
      setBusy(`Kontroller okunuyor… ${done}/${take.length}`);
      return { card, hash, gate };
    });
    const checked = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            card: take[i] as PostCard,
            hash: null,
            gate: {
              kind: "unfinished" as const,
              version: 0,
              reason: describeError(r.reason),
            },
          },
    );
    setBusy(null);
    if (checked.every((g) => g.gate.kind === "clear" && g.hash) && skip.length === 0) {
      await approveAll(checked, false);
      return;
    }
    setGated({ checked, skipped: skip });
  };

  const duplicate = async () => {
    setBusy("Çoğaltılıyor…");
    const results = await mapLimit(picked, 3, (c) => api.contents.duplicate(c.id));
    await invalidatePosts(queryClient);
    setBusy(null);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({ message: ok === 1 ? "1 kopya oluşturuldu." : `${ok} kopya oluşturuldu.` });
    const failed = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (failed) toast({ message: describeError(failed.reason), tone: "danger" });
  };

  const remove = async () => {
    const { take, skip } = deletable(picked);
    if (take.length === 0) {
      toast({ message: skip[0]?.reason ?? "Silinecek post yok." });
      return;
    }
    setBusy("Siliniyor…");
    await trashPosts(
      api,
      queryClient,
      take.map((c) => c.content),
    );
    setBusy(null);
    if (skip.length > 0)
      toast({ message: `${skip.length} post silinmedi: ${skip[0]?.reason ?? ""}` });
  };

  const clean = gated?.checked.filter((g) => g.gate.kind === "clear" && g.hash) ?? [];
  const blocked = gated?.checked.filter((g) => !(g.gate.kind === "clear" && g.hash)) ?? [];
  const forcible = gated?.checked.filter((g) => g.hash) ?? [];

  return (
    <div
      role="toolbar"
      aria-label="Seçili postlar"
      className="glass flex h-10 items-center gap-1 rounded-full py-1 pr-1 pl-3"
    >
      <span className="mr-1 text-body text-fg">{picked.length} post seçili</span>
      {picked.length < visibleCount && (
        <Button variant="ghost" onClick={onSelectAll} disabled={!!busy}>
          Tümünü seç ({visibleCount})
        </Button>
      )}
      <span className="mx-1 h-4 w-px bg-hairline" />
      {busy ? (
        <span className="flex items-center gap-2 px-2 text-body text-fg-2">
          <Spinner size={12} /> {busy}
        </span>
      ) : (
        <>
          <Button variant="ghost" onClick={() => void approve()}>
            Onayla
          </Button>
          <Button variant="ghost" onClick={() => setScheduling(true)}>
            Zamanla
          </Button>
          <Button variant="ghost" onClick={() => setRevising(true)}>
            Talimat uygula
          </Button>
          <Button variant="ghost" onClick={() => setConverting(true)}>
            Dönüştür
          </Button>
          <Button variant="ghost" onClick={() => void duplicate()}>
            Çoğalt
          </Button>
          <Button variant="ghost" className="text-danger" onClick={() => void remove()}>
            Sil
          </Button>
        </>
      )}
      <button
        type="button"
        aria-label="Seçimi kaldır"
        title="Seçimi kaldır (Esc)"
        onClick={clear}
        className="ml-1 flex size-7 items-center justify-center rounded-full text-icon hover:bg-control"
      >
        <IconClose size={14} />
      </button>
      <Dialog
        open={gated !== null}
        title="Bazı postların kontrolleri geçmedi"
        onClose={() => setGated(null)}
        width={520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setGated(null)}>
              Vazgeç
            </Button>
            <Button
              variant="secondary"
              disabled={forcible.length === 0 || forcible.length === clean.length}
              onClick={() => void approveAll(forcible, true)}
            >
              Yine de hepsini onayla ({forcible.length})
            </Button>
            <Button
              variant="primary"
              data-autofocus=""
              disabled={clean.length === 0}
              onClick={() => void approveAll(clean, false)}
            >
              Yalnızca sorunsuzları onayla ({clean.length})
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-body">
          <p className="text-fg-2">
            {clean.length} post sorunsuz. Aşağıdakiler kontrolleri geçmedi ya da kontrolleri
            bitmedi:
          </p>
          <ul className="flex flex-col gap-2">
            {blocked.map(({ card, gate }) => (
              <li key={card.id} className="rounded-[10px] bg-control px-3 py-2">
                <div className="truncate font-medium text-fg">{card.content.title}</div>
                {gate.kind === "problems" ? (
                  <>
                    <div className="text-footnote text-danger">{gate.warning.title}</div>
                    {gate.warning.lines.slice(0, 3).map((line) => (
                      <div key={line} className="truncate text-footnote text-fg-2">
                        {line}
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="text-footnote text-fg-2">
                    {gate.kind === "unfinished" ? gate.reason : ""}
                  </div>
                )}
              </li>
            ))}
            {gated?.skipped.map(({ card, reason }) => (
              <li key={card.id} className="px-3 text-footnote text-fg-3">
                {card.content.title}: {reason}
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
      <ScheduleSheet
        open={scheduling}
        cards={picked}
        onClose={() => setScheduling(false)}
        onDone={() => {
          setScheduling(false);
          clear();
        }}
      />
      <ConvertDialog
        open={converting}
        cards={picked}
        onClose={() => setConverting(false)}
        onDone={() => {
          setConverting(false);
          clear();
        }}
      />
      <InstructionSheet
        open={revising}
        cards={picked}
        onClose={() => setRevising(false)}
        onDone={() => {
          setRevising(false);
          clear();
        }}
      />
    </div>
  );
}

// --- Zamanla --------------------------------------------------------------------------------------

function ScheduleSheet({
  open,
  cards,
  onClose,
  onDone,
}: {
  open: boolean;
  cards: PostCard[];
  onClose(): void;
  onDone(): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const today = new Date();
  const [mode, setMode] = useState<SpreadMode>("planned");
  const [from, setFrom] = useState(dateInput(new Date(today.getTime() + 86_400_000)));
  const [to, setTo] = useState(dateInput(new Date(today.getTime() + 7 * 86_400_000)));
  const [time, setTime] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const { take, skip } = useMemo(() => schedulable(cards), [cards]);
  const timings = useMemo(
    () => spreadTimes(take, { mode, from, to, time }),
    [take, mode, from, to, time],
  );
  const rows = timings.map((t) => {
    const targets: SocialAccount[] = bulkAccounts(t.card, accounts);
    const problem =
      t.reason ??
      (t.at ? dateError(t.at) : null) ??
      (targets.length === 0 ? "Bu postun platformlarında bağlı hesap yok." : null);
    return { ...t, targets, problem };
  });
  const ready = rows.filter((r) => !r.problem && r.at);

  const submit = async () => {
    setBusy(true);
    const results = await mapLimit(ready, 2, (row) =>
      submitSchedule(api, {
        content: row.card.content,
        hash: null,
        accountIds: row.targets.map((a) => a.id),
        offeredAccountIds: row.targets.map((a) => a.id),
        date: row.at as Date,
      }),
    );
    await invalidatePosts(queryClient);
    setBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    toast({ message: `${ok} post zamanlandı.` });
    const failed = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (failed) toast({ message: describeError(failed.reason), tone: "danger" });
    if (ok > 0) onDone();
  };

  return (
    <Dialog
      open={open}
      title={`${cards.length} postu zamanla`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            data-autofocus=""
            disabled={busy || ready.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Zamanlanıyor…" : `${ready.length} postu zamanla`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-body">
        <SegmentedControl<SpreadMode>
          label="Tarih"
          value={mode}
          onChange={setMode}
          options={[
            { value: "planned", label: "Her postun kendi günü" },
            { value: "spread", label: "Günlere yay" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {mode === "spread" && (
            <>
              <input
                type="date"
                aria-label="İlk gün"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)]"
              />
              <span className="text-fg-3">–</span>
              <input
                type="date"
                aria-label="Son gün"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)]"
              />
            </>
          )}
          <input
            type="time"
            aria-label="Saat"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-7 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)]"
          />
        </div>
        <p className="text-footnote text-fg-2">
          {mode === "planned"
            ? "Her post planındaki gün (ya da şimdiki zamanlaması) bu saatte paylaşılır; aynı güne düşenler 30 dakika arayla."
            : "Postlar sırayla bu günlere eşit dağıtılır; aynı güne düşenler 30 dakika arayla."}{" "}
          Postun markasının bağlı hesaplarına gider.
        </p>
        <ul aria-label="Zamanlanacak postlar" className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.card.id}
              className="flex h-8 items-center gap-2 border-b border-hairline last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-fg">{row.card.content.title}</span>
              <span
                className={cn("shrink-0 text-footnote", row.problem ? "text-danger" : "text-fg-2")}
              >
                {row.problem ?? (row.at ? shortDayTime(row.at) : "")}
              </span>
            </li>
          ))}
          {skip.map(({ card, reason }) => (
            <li key={card.id} className="flex h-8 items-center gap-2 text-fg-3">
              <span className="min-w-0 flex-1 truncate">{card.content.title}</span>
              <span className="shrink-0 text-footnote">{reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

// --- Talimat uygula (N3) ---------------------------------------------------------------------------

function InstructionSheet({
  open,
  cards,
  onClose,
  onDone,
}: {
  open: boolean;
  cards: PostCard[];
  onClose(): void;
  onDone(): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const [loseApproval, setLoseApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { take, skip } = useMemo(() => revisable(cards), [cards]);
  const losing = approvalLosses(take);
  const going = loseApproval ? take : take.filter((c) => !losing.includes(c));
  const brandId = take[0]?.content.brandId;

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.contents.revise({
        contentIds: going.map((c) => c.id),
        instruction: instruction.trim(),
        ...(loseApproval ? { confirmApprovalLoss: true } : {}),
      });
      await invalidatePosts(queryClient);
      const parts = [`${result.jobs.length} post için düzeltme kuyruğa alındı`];
      if (result.canvas)
        parts.push(`${result.canvas.contentIds.length} tuval postu sohbete verildi`);
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} post atlandı`);
      const conversationId = result.canvas?.conversationId;
      toast({
        message: `${parts.join("; ")}.`,
        ...(conversationId
          ? {
              action: {
                label: "Sohbeti aç",
                run: () =>
                  useAppStore.getState().navigate({ kind: "conversation", id: conversationId }),
              },
              durationMs: UNDO_TOAST_MS,
            }
          : {}),
      });
      setInstruction("");
      onDone();
    } catch (e) {
      toast({ message: describeError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (needsEstimate(going.length)) setConfirming(true);
    else void run();
  };

  return (
    <>
      <Dialog
        open={open && !confirming}
        title={`${cards.length} posta talimat uygula`}
        onClose={onClose}
        width={540}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              disabled={busy || going.length === 0 || !instruction.trim()}
              onClick={start}
            >
              {busy ? "Gönderiliyor…" : `${going.length} posta uygula`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-body">
          <textarea
            aria-label="Talimat"
            data-autofocus=""
            value={instruction}
            rows={4}
            maxLength={4000}
            placeholder="Örn. Başlıkları kısalt, alt yazıda markanın sloganını kullan."
            onChange={(e) => setInstruction(e.target.value)}
            className="selectable resize-y rounded-[10px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3"
          />
          <p className="text-footnote text-fg-2">
            Her post için güncel sürümden bir düzeltme üretilir; tuvalde düzenlenmiş postlar elle
            yaptığın değişiklikler korunarak sohbetteki asistana verilir.
          </p>
          {losing.length > 0 && (
            <Checkbox checked={loseApproval} onChange={setLoseApproval}>
              {losing.length} onaylı ya da zamanlanmış post da değişsin (onayları kalkar,
              zamanlamaları iptal edilir)
            </Checkbox>
          )}
          {skip.length > 0 && (
            <ul className="flex flex-col gap-1 text-footnote text-fg-3">
              {skip.map(({ card, reason }) => (
                <li key={card.id} className="truncate">
                  {card.content.title}: {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
      <EstimateDialog
        query={confirming && brandId ? { count: going.length, brandId } : null}
        title="Talimat uygulansın mı?"
        what={`${going.length} post yeniden üretilecek.`}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await run();
        }}
      />
    </>
  );
}
