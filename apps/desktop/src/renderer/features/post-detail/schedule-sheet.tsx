// "Postu zamanla" sheet: local date and time, the brand's accounts on the post's platforms
// (with the platform rules each one reports — preflight, rechecked on every change), the
// publishing mode, then "Zamanla" (approving first when needed) or "Şimdi yayınla" after a
// confirmation.
import type { Content, SchedulePreflight, SocialAccount } from "@studio/contract";
import { readReelVersionInfo } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog.tsx";
import { PlatformIcon } from "../../components/ui/icons.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { invalidatePosts, storeContent, usePublishingStatus } from "../posts/data.ts";
import { dateInput, dayTime, fromInputs, timeInput, timeZoneLabel } from "../posts/dates.ts";
import {
  accountLabel,
  blockingReason,
  dateError,
  defaultAccountIds,
  modeSummary,
  needsApproval,
  preflightIssues,
  publishNowConfirmation,
  SubmitError,
  schedulableAccounts,
  submitPublishNow,
  submitSchedule,
} from "./schedule.ts";

const STATUS_NOTE: Partial<Record<SocialAccount["status"], string>> = {
  pending: "Bağlantı tamamlanmadı — önce Ayarlar → Hesaplar'dan bağlayın.",
  needs_reauth: "Yeniden bağlanması gerekiyor — Ayarlar → Hesaplar.",
};

export function ScheduleSheet({
  open,
  content,
  slideHtml,
  hash,
  accounts,
  initialDate,
  onClose,
  onDone,
}: {
  open: boolean;
  content: Content;
  /** First slide of the current version (a reel's duration). */
  slideHtml: string | null;
  /** The verified hash, for approving first (null: not verified). */
  hash: string | null;
  accounts: SocialAccount[];
  initialDate: Date;
  onClose(): void;
  onDone(content: Content): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const publishing = usePublishingStatus();
  const candidates = useMemo(() => schedulableAccounts(accounts, content), [accounts, content]);
  const [date, setDate] = useState(dateInput(initialDate));
  const [time, setTime] = useState(timeInput(initialDate));
  const [selected, setSelected] = useState<string[]>(() => defaultAccountIds(candidates));
  const [preflight, setPreflight] = useState<SchedulePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);
  const generation = useRef(0);
  const opening = useRef({ initialDate, candidates });
  opening.current = { initialDate, candidates };

  // Reset when it opens again.
  useEffect(() => {
    if (!open) return;
    const { initialDate: start, candidates: list } = opening.current;
    setDate(dateInput(start));
    setTime(timeInput(start));
    setSelected(defaultAccountIds(list));
    setError(null);
    setPreflight(null);
    setConfirmNow(false);
  }, [open]);

  const at = fromInputs(date, time);
  const dateProblem = dateError(at);
  const reelDurationMs =
    content.type === "reel" && slideHtml ? readReelVersionInfo(slideHtml).durationMs : null;
  const approvalNeeded = needsApproval(content);
  const block = blockingReason({
    content,
    accounts: candidates,
    selected,
    preflight,
    reelDurationMs,
    approvable: approvalNeeded ? hash !== null : true,
  });
  const atIso = at && !dateProblem ? at.toISOString() : null;
  const selectedKey = [...selected].sort().join(",");

  // Platform rules: debounced, rechecked when the accounts or the time change.
  useEffect(() => {
    if (!open) return;
    const ids = selectedKey ? selectedKey.split(",") : [];
    if (ids.length === 0) {
      setPreflight(null);
      setChecking(false);
      return;
    }
    const mine = ++generation.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api.schedules
        .preflight({
          contentId: content.id,
          socialAccountIds: ids,
          ...(atIso ? { scheduledAt: atIso } : {}),
        })
        .then((result) => {
          if (mine !== generation.current) return;
          setPreflight(result);
          setError(null);
        })
        .catch((e) => {
          if (mine === generation.current) setError(describeError(e));
        })
        .finally(() => {
          if (mine === generation.current) setChecking(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [open, api, content.id, selectedKey, atIso]);

  const finish = async (result: { content: Content; schedules: unknown[] }, message: string) => {
    storeContent(queryClient, result.content);
    await invalidatePosts(queryClient, content.id);
    void api.publishing.requestSync().catch(() => undefined);
    useAppStore.getState().showToast({ message });
    onDone(result.content);
    onClose();
  };

  const schedule = async () => {
    if (!at || dateProblem || block) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitSchedule(api, { content, hash, accountIds: selected, date: at });
      await finish(result, `Zamanlandı: ${dayTime(at)}`);
    } catch (e) {
      setError(describeError(e));
      if (e instanceof SubmitError && e.created.length > 0)
        await invalidatePosts(queryClient, content.id);
    } finally {
      setSubmitting(false);
    }
  };

  const publishNow = async () => {
    setConfirmNow(false);
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitPublishNow(api, { content, hash, accountIds: selected });
      await finish(result, "Yayın başladı.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const mode = publishing.data?.mode ?? "local";
  const chosen = candidates.filter((a) => selected.includes(a.id));
  const canSchedule = !block && !dateProblem && !submitting && !checking;
  const canPublishNow = !block && !submitting && !checking;

  return (
    <>
      <Dialog
        open={open && !confirmNow}
        title={content.status === "scheduled" ? "Zamanlamayı değiştir" : "Postu zamanla"}
        onClose={onClose}
        width={480}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Vazgeç
            </Button>
            <Button
              variant="secondary"
              disabled={!canPublishNow}
              onClick={() => setConfirmNow(true)}
            >
              Şimdi yayınla
            </Button>
            <Button
              variant="primary"
              disabled={!canSchedule}
              onClick={() => void schedule()}
              data-autofocus=""
            >
              {submitting ? "Gönderiliyor…" : approvalNeeded ? "Onayla ve zamanla" : "Zamanla"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="truncate text-body text-fg-2">
            <span className="text-fg">{content.title}</span>
          </p>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Yayın zamanı</span>
            <div className="flex items-center gap-2">
              <TextField
                type="date"
                aria-label="Tarih"
                className="w-[160px]"
                value={date}
                min={dateInput(new Date())}
                invalid={!!dateProblem}
                onChange={(e) => setDate(e.target.value)}
              />
              <TextField
                type="time"
                aria-label="Saat"
                className="w-[110px]"
                value={time}
                invalid={!!dateProblem}
                onChange={(e) => setTime(e.target.value)}
              />
              <span className="text-footnote text-fg-3">{timeZoneLabel()}</span>
            </div>
            {dateProblem && <span className="text-footnote text-danger">{dateProblem}</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Hesaplar</span>
            {candidates.length === 0 && (
              <p className="text-body text-fg-3">
                Bu postun platformlarında bağlı hesap yok. Ayarlar → Hesaplar'dan bağlayın.
              </p>
            )}
            <div className="flex flex-col gap-1">
              {candidates.map((account) => {
                const isSelected = selected.includes(account.id);
                const issues = preflightIssues(preflight, account.id);
                const target = preflight?.targets.find((t) => t.socialAccountId === account.id);
                return (
                  <div
                    key={account.id}
                    className="flex flex-col gap-1 rounded-[10px] px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        label={accountLabel(account)}
                        checked={isSelected}
                        onChange={(on) =>
                          setSelected((list) =>
                            on ? [...list, account.id] : list.filter((id) => id !== account.id),
                          )
                        }
                      />
                      <PlatformIcon platform={account.platform} size={15} className="text-icon" />
                      <span className="min-w-0 flex-1 truncate text-body text-fg">
                        {accountLabel(account)}
                      </span>
                      {isSelected && target && (
                        <TagPill tone={target.ok ? "success" : "danger"}>
                          {target.ok ? "Uygun" : "Sorunlu"}
                        </TagPill>
                      )}
                    </div>
                    {STATUS_NOTE[account.status] && (
                      <span className="pl-6 text-footnote text-accent-text">
                        {STATUS_NOTE[account.status]}
                      </span>
                    )}
                    {isSelected &&
                      issues.errors.map((issue) => (
                        <span
                          key={issue.code + issue.path}
                          className="pl-6 text-footnote text-danger"
                        >
                          ✕ {issue.message}
                        </span>
                      ))}
                    {isSelected &&
                      issues.warnings.map((issue) => (
                        <span
                          key={issue.code + issue.path}
                          className="pl-6 text-footnote text-fg-2"
                        >
                          ! {issue.message}
                        </span>
                      ))}
                  </div>
                );
              })}
            </div>
            {checking && (
              <span className="flex items-center gap-1.5 text-footnote text-fg-2">
                <Spinner size={11} /> Platform kuralları denetleniyor…
              </span>
            )}
          </div>

          <p className="text-footnote text-fg-2">
            {approvalNeeded && "Önce bu sürüm onaylanacak. "}
            {modeSummary(mode)}
          </p>
          {block && (
            <p className="text-footnote text-accent-text" role="status">
              {block}
            </p>
          )}
          {error && (
            <p className={cn("selectable text-footnote text-danger")} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={open && confirmNow}
        title="Şimdi yayınlansın mı?"
        message={publishNowConfirmation(content.title, chosen)}
        confirmLabel="Yayınla"
        busy={submitting}
        onConfirm={() => void publishNow()}
        onClose={() => setConfirmNow(false)}
      />
    </>
  );
}
