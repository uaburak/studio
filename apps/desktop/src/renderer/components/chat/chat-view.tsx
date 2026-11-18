// A conversation: the transcript (710 pt column, follows the bottom without jumps), the glass
// composer floating over it, the status line, "jump to latest".
import type { ConversationAlias, WorkerPresence } from "@studio/contract";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollFollower, type ScrollMetrics, showJumpToLatest } from "../../lib/scroll-follow.ts";
import { buildTranscript, type TranscriptItem } from "../../lib/transcript.ts";
import { canRunChat } from "../../lib/usage.ts";
import { useAppStore } from "../../state/app-store.ts";
import type { ConversationController } from "../../state/conversation.ts";
import { useAgentChoice, useConversation, useJobs } from "../../state/studio.tsx";
import { cn, WorkingDots } from "../ui/controls.tsx";
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
                className="mb-2 flex items-center gap-2 px-3 text-footnote text-danger"
                role="alert"
              >
                <span className="flex-1">{conversation.error}</span>
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
            <Composer
              ref={composer}
              placeholder={placeholder}
              workingPlaceholder="↩ gönder, ⌘↩ sıraya al"
              working={working}
              brandId={state?.conversation.brandId ?? null}
              attachDisabledReason={
                state && !state.conversation.brandId ? "Markasız sohbete görsel eklenemez." : null
              }
              aliases={aliases}
              onSend={async (message) => {
                follow.resume();
                setPlaceholder("Bir şey sor…");
                return controller.send(message);
              }}
              onStop={() => void controller.cancelRun()}
            />
            <div className="mt-1.5">
              <StatusLine choice={choice} onChoice={setChoice} presence={presence} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TranscriptItems({
  items,
  aliases,
  controller,
  onMention,
  onEditPlan,
  onEditQueued,
}: {
  items: TranscriptItem[];
  aliases: ConversationAlias[];
  controller: ConversationController;
  onMention(aliasId: string): void;
  onEditPlan(): void;
  onEditQueued(text: string): void;
}) {
  return (
    <>
      {items.map((item) => {
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
              <div key={item.key} className="my-5 first:mt-0">
                <UserBubble
                  text={item.text}
                  mentions={item.mentions}
                  images={item.images}
                  aliases={aliases}
                  onMention={onMention}
                />
              </div>
            );
          case "assistant":
            return (
              <AssistantMessage
                key={item.key}
                item={item}
                aliases={aliases}
                controller={controller}
                onMention={onMention}
                onEditPlan={onEditPlan}
              />
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
