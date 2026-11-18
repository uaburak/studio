// "Zamanlamayı iptal et": a confirmation (with a box per account when the post waits on several),
// then the picked pending schedules are cancelled and the posts' and the calendar's lists and
// the post itself are refreshed. Used by the open post (… menu, schedule sheet, publish
// history) and by the calendar rows.
import type { Content, Schedule, SocialAccount } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { invalidatePosts, storeContent } from "../posts/data.ts";
import {
  CancelError,
  type CancelTarget,
  cancelConfirmation,
  cancelSchedules,
  cancelTargets,
} from "./schedule.ts";

export function CancelScheduleDialog({
  open,
  title,
  contentId,
  targets,
  initial,
  onClose,
  onDone,
}: {
  open: boolean;
  /** The post's title. */
  title: string;
  contentId: string;
  /** Pending schedules on offer (one per account). */
  targets: readonly CancelTarget[];
  /** Picked when it opens (null: all of them). */
  initial?: readonly string[] | null;
  onClose(): void;
  /** After at least one schedule was cancelled, with the post as it is now. */
  onDone?(content: Content | null): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef({ targets, initial });
  opening.current = { targets, initial };

  // Reset when it opens again.
  useEffect(() => {
    if (!open) return;
    const { targets: list, initial: start } = opening.current;
    const ids = list.map((t) => t.scheduleId);
    setPicked(start ? ids.filter((id) => start.includes(id)) : ids);
    setError(null);
  }, [open]);

  const confirm = async () => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    let count = 0;
    let failure: string | null = null;
    try {
      count = (await cancelSchedules(api.schedules, picked)).length;
    } catch (e) {
      count = e instanceof CancelError ? e.cancelled.length : 0;
      failure = describeError(e);
    }
    let content: Content | null = null;
    if (count > 0) {
      content = await api.contents.get(contentId).catch(() => null);
      if (content) storeContent(queryClient, content);
      await invalidatePosts(queryClient, contentId);
      onDone?.(content);
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    useAppStore.getState().showToast({
      message: count > 1 ? `${count} zamanlama iptal edildi.` : "Zamanlama iptal edildi.",
    });
    onClose();
  };

  const several = targets.length > 1;
  return (
    <ConfirmDialog
      open={open}
      title="Zamanlama iptal edilsin mi?"
      confirmLabel={busy ? "İptal ediliyor…" : "Zamanlamayı iptal et"}
      cancelLabel="Vazgeç"
      destructive
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={() => {
        if (!busy) onClose();
      }}
      message={
        <div className="flex flex-col gap-2.5">
          <p>{cancelConfirmation(title, several ? picked.length : 1)}</p>
          {several ? (
            <div className="flex flex-col gap-1.5">
              {targets.map((t) => (
                <Checkbox
                  key={t.scheduleId}
                  label={t.label}
                  checked={picked.includes(t.scheduleId)}
                  disabled={busy}
                  onChange={(on) =>
                    setPicked((list) =>
                      on ? [...list, t.scheduleId] : list.filter((id) => id !== t.scheduleId),
                    )
                  }
                >
                  {t.label}
                </Checkbox>
              ))}
              {picked.length === 0 && (
                <span className="text-footnote text-fg-3">En az bir zamanlama seç.</span>
              )}
            </div>
          ) : (
            targets[0] && <p className="text-fg">{targets[0].label}</p>
          )}
          {error && (
            <p className="text-footnote text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}

/**
 * The open post's cancel flow: which schedules can be cancelled, `open()` (all, or the given
 * ones) and the dialog to render.
 */
export function useCancelSchedule({
  content,
  schedules,
  accounts,
  onDone,
}: {
  content: Pick<Content, "id" | "title">;
  schedules: readonly Schedule[];
  accounts: readonly SocialAccount[];
  onDone?(content: Content | null): void;
}) {
  const targets = useMemo(() => cancelTargets(schedules, accounts), [schedules, accounts]);
  const [state, setState] = useState<{ open: boolean; initial: string[] | null }>({
    open: false,
    initial: null,
  });
  const dialog = (
    <CancelScheduleDialog
      open={state.open && targets.length > 0}
      title={content.title}
      contentId={content.id}
      targets={targets}
      initial={state.initial}
      onClose={() => setState({ open: false, initial: null })}
      {...(onDone ? { onDone } : {})}
    />
  );
  return {
    /** Pending schedules on offer; empty: nothing to cancel. */
    targets,
    isOpen: state.open && targets.length > 0,
    open: (scheduleIds?: readonly string[]) =>
      setState({ open: true, initial: scheduleIds ? [...scheduleIds] : null }),
    dialog,
  };
}
