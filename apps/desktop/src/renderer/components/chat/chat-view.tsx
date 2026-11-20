// A conversation: the transcript (710 pt column, follows the bottom without jumps), the glass
// composer floating over it, the status line, "jump to latest".
import type { Conversation, ConversationAlias, WorkerPresence } from "@studio/contract";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openEntityMention, useMentionCandidates } from "../../features/mentions/mentions-data.ts";
import { ScrollFollower, type ScrollMetrics, showJumpToLatest } from "../../lib/scroll-follow.ts";
import { buildTranscript, type TranscriptItem } from "../../lib/transcript.ts";
import { canRunChat } from "../../lib/usage.ts";
import { useAppStore } from "../../state/app-store.ts";
import type { ConversationController } from "../../state/conversation.ts";
import { useFocusRequests } from "../../state/focus-requests.ts";
import { useAgentChoice, useConversation, useJobs } from "../../state/studio.tsx";
import { useConversationActions } from "../shell/conversation-actions.ts";
import { Button, cn, WorkingDots } from "../ui/controls.tsx";
import { ErrorDetail } from "../ui/error-detail.tsx";
import { IconArrowUp, IconClose } from "../ui/icons.tsx";
import { EventLine, WorkingLine } from "./blocks.tsx";
import { Composer, type ComposerHandle } from "./composer.tsx";
import { AssistantMessage, QueuedBubble, UserBubble } from "./messages.tsx";
import { StatusLine } from "./status-line.tsx";

export const COLUMN = "mx-auto w-full max-w-[758px] px-6";

function metrics(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}

/** Scroll container + content that follow the bottom (lib/scroll-follow.ts). */
export function useFollowBottom() {
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const follower = useRef(new ScrollFollower());
  const [jump, setJump] = useState(false);

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = follower.current.onResize(metrics(el));
    if (top !== null) el.scrollTop = top;
    setJump(showJumpToLatest(follower.current.following, metrics(el)));
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => pin());
    observer.observe(el);
    observer.observe(inner);
    pin();
    return () => observer.disconnect();
  }, [pin]);

  return {
    scroller,
    content,
    jump,
    /** Stop following the bottom (the view scrolls to an earlier message). */
    pause: () => follower.current.onUserScrollUp(),
    onScroll: () => {
      const el = scroller.current;
      if (!el) return;
      const following = follower.current.onScroll(metrics(el));
      setJump(showJumpToLatest(following, metrics(el)));
    },
    onWheel: (event: React.WheelEvent) => {
      if (event.deltaY < 0) follower.current.onUserScrollUp();
    },
    resume: (smooth = false) => {
      follower.current.resume();
      const el = scroller.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      setJump(false);
    },
  };
}

export function JumpToLatest({ working, onClick }: { working: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label="En sona git"
      onClick={onClick}
      className="glass absolute -top-11 left-1/2 flex size-8 -translate-x-1/2 animate-pop-in items-center justify-center rounded-full text-fg-2 hover:text-fg"
    >
      {working ? (
        <WorkingDots size={14} />
      ) : (
        <IconArrowUp size={14} strokeWidth={2} className="rotate-180" />
      )}
    </button>
  );
}

export function ChatView({ id }: { id: string }) {
  const conversation = useConversation(id);
  const { state, controller } = conversation;
  const jobs = useJobs();
  const [choice, setChoice] = useAgentChoice(id);
  const openLightbox = useAppStore((s) => s.openLightbox);
  const focusSignal = useAppStore((s) => s.focusComposer);
  const composer = useRef<ComposerHandle | null>(null);
  const [placeholder, setPlaceholder] = useState("Bir şey sor…");
  const follow = useFollowBottom();
  const presence: WorkerPresence | null = state?.presence ?? jobs.presence;
  const aliases = state?.aliases ?? [];
  const entities = useMentionCandidates(state?.conversation.brandId ?? null);

  useLayoutEffect(() => {
    if (focusSignal) composer.current?.focus();
  }, [focusSignal]);

  const items = useMemo(
    () =>
      buildTranscript({
        hasState: state !== null,
        connectionTrouble: conversation.live === "closed",
        messages: state?.messages ?? [],
        plans: state?.plans ?? [],
        aliases,
        activeRun: state?.activeRun ?? null,
        runWaitingForMac: state?.activeRun?.status === "queued" && !canRunChat(presence),
        isOnline: presence?.online ?? true,
        expandedSteps: conversation.expandedSteps,
        busyPlans: conversation.busyPlans,
        busyQuestions: conversation.busyQuestions,
        busyConsents: conversation.busyConsents,
        planErrors: conversation.planErrors,
        queue: conversation.queue,
        stepStarts: conversation.stepStarts,
      }),
    [
      state,
      aliases,
      presence,
      conversation.live,
      conversation.expandedSteps,
      conversation.busyPlans,
      conversation.busyQuestions,
      conversation.busyConsents,
      conversation.planErrors,
      conversation.queue,
      conversation.stepStarts,
    ],
  );

  const onMention = (aliasId: string) => {
    const alias = aliases.find((a) => a.id === aliasId);
    if (alias)
      openLightbox({
        images: [
          {
            assetId: alias.assetId,
            width: alias.width,
            height: alias.height,
            caption: `@${alias.alias}`,
            aliasId,
          },
        ],
        index: 0,
      });
  };

  const working = conversation.isReplyActive;
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={follow.scroller}
        onScroll={follow.onScroll}
        onWheel={follow.onWheel}
        className="scroll-area absolute inset-0 overflow-x-hidden [overflow-anchor:none]"
      >
        <div ref={follow.content} className={cn(COLUMN, "pt-7 pb-[148px]")}>
          <TranscriptItems
            items={items}
            aliases={aliases}
            controller={controller}
            brandId={state?.conversation.brandId ?? null}
            onFocusScroll={follow.pause}
            onMention={onMention}
            onEditPlan={() => {
              setPlaceholder("Planda neyi değiştireyim?");
              composer.current?.focus();
            }}
            onEditQueued={(text) => composer.current?.setText(text)}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        {/* Content fades out behind the glass composer; the status line sits on the page. */}
        <div className="h-6 bg-gradient-to-b from-transparent to-page/40" />
        <div className="bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--bg-page)_40%,transparent),var(--bg-page)_40px)]">
          <div className={cn(COLUMN, "pointer-events-auto relative pb-2.5")}>
            {follow.jump && <JumpToLatest working={working} onClick={() => follow.resume(true)} />}
            {conversation.error && (
              <div
                className="mb-2 flex items-start gap-2 px-3 text-footnote text-danger"
                role="alert"
              >
                <span className="min-w-0 flex-1">
                  {conversation.error}
                  <ErrorDetail detail={conversation.errorDetail} />
                </span>
                <button
                  type="button"
                  aria-label="Kapat"
                  onClick={() => controller.clearError()}
                  className="text-fg-2 hover:text-fg"
                >
                  <IconClose size={12} />
                </button>
              </div>
            )}
            {state?.conversation.status === "archived" ? (
              <ArchivedBar conversation={state.conversation} />
            ) : (
              <Composer
                ref={composer}
                placeholder={placeholder}
                workingPlaceholder="↩ sıraya al · ⌘↩ durdurup hemen gönder"
                working={working}
                brandId={state?.conversation.brandId ?? null}
                attachDisabledReason={
                  state && !state.conversation.brandId ? "Markasız sohbete görsel eklenemez." : null
                }
                aliases={aliases}
                entities={entities}
                onSend={async (message, { now }) => {
                  follow.resume();
                  setPlaceholder("Bir şey sor…");
                  const ok = await controller.send(message);
                  // ⌘↩ while a reply runs: it stops and this message goes first.
                  if (ok && now) void controller.sendQueuedNow(message.clientMessageId);
                  return ok;
                }}
                onStop={() => void controller.cancelRun()}
              />
            )}
            <div className="mt-1.5">
              <StatusLine choice={choice} onChoice={setChoice} presence={presence} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** An archived conversation (opened from Arşiv) is read-only until it is taken back. */
function ArchivedBar({ conversation }: { conversation: Conversation }) {
  const actions = useConversationActions();
  const [busy, setBusy] = useState(false);
  return (
    <div className="glass-composer flex min-h-11 items-center gap-3 rounded-[22px] py-1.5 pr-1.5 pl-4">
      <span className="min-w-0 flex-1 text-body text-fg-2">
        Bu sohbet arşivde. Yazmak için arşivden çıkar.
      </span>
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void actions.unarchive(conversation).finally(() => setBusy(false));
        }}
      >
        {busy ? "Çıkarılıyor…" : "Arşivden çıkar"}
      </Button>
    </div>
  );
}

/** The message a transcript item shows (users' and the assistant's), else null. */
export function itemMessageId(item: TranscriptItem): string | null {
  if (item.kind === "user") return item.id;
  if (item.kind === "assistant") return item.message.id;
  return null;
}

/**
 * A "go to this message" request for this conversation (focus-requests.ts): once the message
 * is on screen it scrolls to the middle and stays highlighted for a moment. Returns the
 * highlighted message.
 */
export function useMessageFocus(
  conversationId: string,
  items: readonly TranscriptItem[],
  onBeforeScroll?: () => void,
): string | null {
  const request = useFocusRequests((s) => s.message);
  const [highlight, setHighlight] = useState<string | null>(null);
  const ready = items.length > 0 && !items.some((i) => i.kind === "loading");
  const before = useRef(onBeforeScroll);
  before.current = onBeforeScroll;
  useEffect(() => {
    if (!request || request.conversationId !== conversationId || !ready) return;
    useFocusRequests.getState().takeMessage(request.nonce);
    const target = request.messageId;
    if (!items.some((i) => itemMessageId(i) === target)) return;
    setHighlight(target);
    const frame = requestAnimationFrame(() => {
      before.current?.();
      const el = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (node) => node.dataset.messageId === target,
      );
      el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [request, conversationId, ready, items]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 2_400);
    return () => clearTimeout(timer);
  }, [highlight]);
  return highlight;
}

function MessageAnchor({
  id,
  highlighted,
  className,
  children,
}: {
  id: string;
  highlighted: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-message-id={id}
      data-highlighted={highlighted || undefined}
      className={cn(
        "rounded-[14px] transition-[background-color,box-shadow] duration-700 ease-out",
        highlighted &&
          "bg-accent-subtle/40 shadow-[0_0_0_8px_color-mix(in_srgb,var(--accent-subtle)_40%,transparent)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TranscriptItems({
  items,
  aliases,
  controller,
  brandId = null,
  onFocusScroll,
  onMention,
  onEditPlan,
  onEditQueued,
}: {
  items: TranscriptItem[];
  aliases: ConversationAlias[];
  controller: ConversationController;
  /** The conversation's brand (an @product chip opens the product on it). */
  brandId?: string | null;
  /** Called before the view scrolls to a requested message (stop following the bottom). */
  onFocusScroll?: () => void;
  onMention(aliasId: string): void;
  onEditPlan(): void;
  onEditQueued(text: string): void;
}) {
  const highlight = useMessageFocus(controller.id, items, onFocusScroll);
  // Only the last reply's error offers "Yeniden dene", and only while nothing runs or waits.
  const busy = items.some((i) => i.kind === "working" || i.kind === "queued");
  let lastAssistant = -1;
  items.forEach((item, index) => {
    if (item.kind === "assistant") lastAssistant = index;
    else if (item.kind === "user") lastAssistant = -1;
  });
  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case "loading":
            return (
              <div key={item.key} className="flex items-center gap-2 py-6 text-body text-fg-2">
                <WorkingDots animated={!item.trouble} />
                {item.trouble ? "Sohbete bağlanılamıyor; yeniden deneniyor…" : "Yükleniyor…"}
              </div>
            );
          case "empty":
            return (
              <div key={item.key} className="py-10 text-center text-body text-fg-3">
                Henüz mesaj yok.
              </div>
            );
          case "user":
            return (
              <MessageAnchor
                key={item.key}
                id={item.id}
                highlighted={highlight === item.id}
                className="my-5 first:mt-0"
              >
                <UserBubble
                  text={item.text}
                  mentions={item.mentions}
                  entityMentions={item.entityMentions}
                  images={item.images}
                  aliases={aliases}
                  onMention={onMention}
                  onEntity={(mention) => openEntityMention(mention, brandId)}
                />
              </MessageAnchor>
            );
          case "assistant":
            return (
              <MessageAnchor
                key={item.key}
                id={item.message.id}
                highlighted={highlight === item.message.id}
              >
                <AssistantMessage
                  item={item}
                  aliases={aliases}
                  controller={controller}
                  onMention={onMention}
                  onEditPlan={onEditPlan}
                  onRetry={
                    index === lastAssistant && !busy && !item.isStreaming
                      ? () => controller.retryLast()
                      : undefined
                  }
                />
              </MessageAnchor>
            );
          case "event":
            return <EventLine key={item.key} text={item.text} />;
          case "working":
            return (
              <WorkingLine
                key={item.key}
                working={item.working}
                onOpenGroup={
                  item.working.groupKey
                    ? () => controller.toggleSteps(item.working.groupKey as string)
                    : undefined
                }
                onCancel={() => void controller.cancelRun()}
              />
            );
          case "queued":
            return (
              <QueuedBubble
                key={item.key}
                item={item}
                controller={controller}
                onEdit={onEditQueued}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}
