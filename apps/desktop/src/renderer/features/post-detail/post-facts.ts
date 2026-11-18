// What the open post's chrome says and offers, shared by the post detail (reels) and the canvas
// workspace (everything else): its state line, the approve / schedule rules and the "…" menu.
import type { Content, ContentVersion } from "@studio/contract";
import type { TagTone } from "../../components/ui/controls.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { useAccounts, useBrands } from "../../state/studio.tsx";
import type { usePostActions } from "../posts/actions.ts";
import {
  cardState,
  deletionBlocker,
  type PostCard,
  pickSchedule,
  STATE_LABEL,
  STATE_TONE,
} from "../posts/board.ts";
import { useContentSchedules, usePlans } from "../posts/data.ts";
import { dayTime } from "../posts/dates.ts";
import { usePostsStore } from "../posts/store.ts";
import {
  approveBlocker,
  changesVersion,
  type EditorSnapshot,
  hasApproval,
  isLocked,
} from "./editor.ts";
import { needsApproval, schedulableAccounts } from "./schedule.ts";

export function usePostFacts(snapshot: EditorSnapshot) {
  const { content } = snapshot;
  const brands = useBrands();
  const accounts = useAccounts();
  const schedules = useContentSchedules(content.id);
  const plans = usePlans(content.brandId);
  const brand = brands.data?.find((b) => b.id === content.brandId);
  const planItem =
    plans.data?.flatMap((p) => p.items).find((item) => item.contentId === content.id) ?? null;
  const schedule = pickSchedule(schedules.data ?? []);
  const card: PostCard = {
    id: content.id,
    content,
    version: snapshot.current,
    planItem,
    schedule,
    job: null,
  };
  const state = cardState(card);
  const allAccounts = accounts.data ?? [];
  const targets = schedulableAccounts(allAccounts, content);
  const busy = changesVersion(snapshot.activity);
  const blocker = approveBlocker(snapshot);
  const locked = isLocked(content);

  const statusText =
    schedule && (state === "scheduled" || state === "publishing" || state === "published")
      ? `${STATE_LABEL[state]} · ${dayTime(new Date(schedule.scheduledAt))}`
      : STATE_LABEL[state];

  // Primary: approve and schedule (or schedule, move the schedule, retry a failed one).
  const approvalFirst = needsApproval(content);
  const scheduleLabel = approvalFirst
    ? "Onayla ve zamanla"
    : content.status === "scheduled"
      ? "Zamanlamayı değiştir"
      : content.status === "failed"
        ? "Yeniden zamanla"
        : "Zamanla";
  const scheduleDisabled = locked
    ? "Yayınlanmış ya da yayınlanan post zamanlanamaz."
    : targets.length === 0
      ? "Bu postun platformlarında bağlı hesap yok; Ayarlar'dan hesap bağla."
      : busy
        ? "Değişiklik render edilirken zamanlanamaz."
        : approvalFirst && blocker
          ? blocker
          : null;

  return {
    brand,
    planItem,
    schedule,
    schedules,
    state,
    statusText,
    tone: STATE_TONE[state] as TagTone,
    allAccounts,
    targets,
    approvalFirst,
    scheduleLabel,
    scheduleDisabled,
    locked,
    approved: hasApproval(content),
  };
}

export type PostFacts = ReturnType<typeof usePostFacts>;

/**
 * The post's "…" menu: quick look, copy the caption, open in chat, cancel the schedule (when it
 * waits on one), duplicate, delete.
 */
export function postMenu({
  content,
  version,
  actions,
  quickLook,
  openInChat,
  cancelSchedule,
}: {
  content: Content;
  version: ContentVersion | null;
  actions: ReturnType<typeof usePostActions>;
  quickLook(): void;
  openInChat(): void;
  /** Opens "Zamanlamayı iptal et"; null when nothing waits to be published. */
  cancelSchedule?: (() => void) | null;
}): MenuEntry[] {
  const blocker = deletionBlocker(content);
  const cancel: MenuEntry[] = cancelSchedule
    ? [{ id: "cancel-schedule", label: "Zamanlamayı iptal et…", onSelect: cancelSchedule }]
    : [];
  return [
    {
      id: "quicklook",
      label: "Hızlı bakış",
      shortcut: "␣",
      disabled: !version?.slides.some((s) => s.renderedAssetId),
      onSelect: quickLook,
    },
    {
      id: "caption",
      label: "Açıklamayı kopyala",
      disabled: !content.caption.trim(),
      onSelect: () => void actions.copyCaption(content),
    },
    { id: "chat", label: "Sohbette aç", onSelect: openInChat },
    ...cancel,
    { type: "separator" },
    {
      id: "duplicate",
      label: "Çoğalt",
      onSelect: async () => {
        const copy = await actions.duplicate(content);
        if (copy) usePostsStore.getState().open(copy.id);
      },
    },
    {
      id: "delete",
      // To the trash at once, with "Geri al" (no question).
      label: "Sil",
      danger: true,
      disabled: !!blocker,
      ...(blocker ? { detail: blocker } : {}),
      onSelect: () => actions.askDelete(content),
    },
  ];
}
