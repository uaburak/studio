import type { Content, Schedule } from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconClock } from "../../components/icons.tsx";
import { InlineError, Notice } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import { Button, Field, Input, Mono, Select } from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import { contentCapabilities } from "../../lib/content-status.ts";
import {
  addDays,
  formatDateTime,
  formatOffset,
  parseWallInputs,
  toDateInput,
  toTimeInput,
  userTimeZone,
  utcToZoned,
  zonedToUtc,
} from "../../lib/datetime.ts";
import { ACCOUNT_STATUS, PLATFORM_LABELS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { useBrandAccounts } from "../brands/AccountsPanel.tsx";

/** Default slot: tomorrow 10:00 in the user's zone. */
export function defaultSlot(now: Date, timeZone: string) {
  const tomorrow = addDays(utcToZoned(now, timeZone), 1);
  return { ...tomorrow, hour: 10, minute: 0 };
}

/**
 * Create a schedule for an approved content item. The user picks a wall-clock
 * time in their own zone; the API receives UTC.
 */
export function ScheduleDialog({
  open,
  onClose,
  content: fixedContent,
  initialDate,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Schedule this content; when omitted the user picks an approved one. */
  content?: Content;
  /** Prefill the date (`YYYY-MM-DD`), e.g. from a calendar day. */
  initialDate?: string;
  onCreated?: (schedule: Schedule) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { brandId } = useBrands();
  const brandName = useBrandName();
  const timeZone = userTimeZone();

  const [contentId, setContentId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  // Pick list: approved (or already scheduled, for another account) content.
  const candidates = useQuery({
    queryKey: ["contents", "list", "schedulable", brandId ?? "all"],
    queryFn: async () => {
      const [approved, scheduled] = await Promise.all([
        api.contents.list({ status: "approved", limit: 100, ...(brandId ? { brandId } : {}) }),
        api.contents.list({ status: "scheduled", limit: 100, ...(brandId ? { brandId } : {}) }),
      ]);
      return [...approved.items, ...scheduled.items].filter(
        (c) => contentCapabilities(c).canSchedule,
      );
    },
    enabled: open && !fixedContent,
  });

  const content = fixedContent ?? candidates.data?.find((c) => c.id === contentId);
  const accounts = useBrandAccounts(content?.brandId);
  const usable = useMemo(
    () =>
      (accounts.data ?? []).filter(
        (a) => a.status !== "disabled" && content?.targetPlatforms.includes(a.platform),
      ),
    [accounts.data, content],
  );

  useEffect(() => {
    if (!open) return;
    const slot = defaultSlot(new Date(), timeZone);
    setDate(initialDate ?? toDateInput(slot));
    setTime(toTimeInput(slot));
    setContentId("");
    setAccountId("");
  }, [open, initialDate, timeZone]);

  useEffect(() => {
    if (!usable.some((a) => a.id === accountId)) setAccountId(usable[0]?.id ?? "");
  }, [usable, accountId]);

  const wall = parseWallInputs(date, time);
  const scheduledAt = wall ? zonedToUtc(wall, timeZone) : null;
  const inPast = scheduledAt !== null && scheduledAt.getTime() <= Date.now();

  const create = useMutation({
    mutationFn: () => {
      if (!content || !scheduledAt) throw new Error("Eksik bilgi");
      return api.schedules.create({
        contentId: content.id,
        socialAccountId: accountId,
        scheduledAt: scheduledAt.toISOString(),
      });
    },
    onSuccess: (schedule) => {
      void qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
      void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
      toast.success("Zamanlandı", formatDateTime(schedule.scheduledAt, timeZone));
      onCreated?.(schedule);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (content && accountId && scheduledAt && !inPast) create.mutate();
  };

  const ready = Boolean(content && accountId && scheduledAt && !inPast);

  return (
    <Dialog
      open={open}
      onClose={() => {
        create.reset();
        onClose();
      }}
      title="Zamanla"
      description={
        content ? `“${content.title}” · ${brandName(content.brandId)}` : "Onaylı bir içerik seçin."
      }
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="schedule-form"
            variant="primary"
            loading={create.isPending}
            disabled={!ready}
          >
            Zamanla
          </Button>
        </>
      }
    >
      <form id="schedule-form" onSubmit={submit} className="flex flex-col gap-4">
        {!fixedContent && (
          <Field
            label="İçerik"
            hint={
              candidates.data && candidates.data.length === 0
                ? "Zamanlanabilir içerik yok: önce bir sürümü onaylayın."
                : "Yalnızca onayı güncel sürümle eşleşen içerikler."
            }
          >
            {(p) => (
              <Select
                {...p}
                value={contentId}
                onChange={(e) => setContentId(e.target.value)}
                required
              >
                <option value="">{candidates.isPending ? "Yükleniyor…" : "İçerik seçin"}</option>
                {(candidates.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} — {brandName(c.brandId)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {content && (
          <Field
            label="Hesap"
            hint={
              accounts.data && usable.length === 0
                ? `Bu markada ${content.targetPlatforms.map((p) => PLATFORM_LABELS[p]).join(" / ") || "hedef platform"} için etkin hesap yok. Markalar sayfasından ekleyin.`
                : "İçeriğin hedef platformlarındaki etkin hesaplar."
            }
          >
            {(p) => (
              <Select
                {...p}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
              >
                {usable.length === 0 && <option value="">Hesap yok</option>}
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {PLATFORM_LABELS[a.platform]} · {a.handle} ({ACCOUNT_STATUS[a.status].label})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Tarih">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Saat">
            {(p) => (
              <Input
                {...p}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
                className="w-32"
              />
            )}
          </Field>
        </div>

        <div className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
          <IconClock size={18} className="mt-px shrink-0 text-ink-3" />
          <div className="min-w-0">
            {scheduledAt ? (
              <>
                <p>
                  <strong className="font-medium text-ink">
                    {formatDateTime(scheduledAt.toISOString(), timeZone)}
                  </strong>{" "}
                  · {timeZone} ({formatOffset(scheduledAt, timeZone)})
                </p>
                <p className="mt-0.5 text-ink-3">
                  UTC olarak kaydedilir:{" "}
                  <Mono>{scheduledAt.toISOString().replace(".000Z", "Z")}</Mono>
                </p>
                {inPast && (
                  <p className="mt-1 font-medium text-bad">Seçilen zaman geçmişte kalıyor.</p>
                )}
              </>
            ) : (
              <p>Geçerli bir tarih ve saat girin.</p>
            )}
          </div>
        </div>

        {usable.find((a) => a.id === accountId)?.status === "connected" ? (
          <Notice tone="good">
            Seçilen saatte bulut zamanlayıcı üzerinden bağlı hesaptan otomatik yayınlanır.
          </Notice>
        ) : (
          <Notice tone="warn">
            Seçilen hesabın token bağlantısı henüz tamamlanmamış. Yayın saatinden önce Markalar
            sayfasından hesabı bağlayın.
          </Notice>
        )}

        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}
