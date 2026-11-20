// The right panel on Sohbet: the post's conversation in panel form — the app's own transcript
// (messages, steps, cards, the working line, queued messages), following the bottom; its
// message box is the dock at the bottom of the canvas. Before the first message: what the chat
// is for and a few starting points.
import { useMemo } from "react";
import {
  JumpToLatest,
  TranscriptItems,
  useFollowBottom,
} from "../../../components/chat/chat-view.tsx";
import { StatusLine } from "../../../components/chat/status-line.tsx";
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import { IconChat, IconClose, IconEllipsis } from "../../../components/ui/icons.tsx";
import { MenuButton } from "../../../components/ui/menu.tsx";
import { buildTranscript } from "../../../lib/transcript.ts";
import { canRunChat } from "../../../lib/usage.ts";
import { useAppStore } from "../../../state/app-store.ts";
import { useJobsSnapshot } from "../../../state/studio.tsx";
import type { PostChat } from "../chat.ts";
import { Chip } from "./fields.tsx";

const STARTERS = [
  "Başlığı daha vurucu yap",
  "Renkleri marka paletine göre canlandır",
  "Açıklamayı kısalt ve hashtag öner",
  "Bu karenin bir varyasyonunu dene",
];

export function ChatPanel({
  chat,
  onStarter,
}: {
  chat: PostChat;
  /** Puts a starting point into the dock's message box. */
  onStarter(text: string): void;
}) {
  const { snapshot, controller } = chat;
  const jobs = useJobsSnapshot();
  const openLightbox = useAppStore((s) => s.openLightbox);
  const follow = useFollowBottom();
  const state = snapshot?.state ?? null;
  const presence = state?.presence ?? jobs.presence;
  const aliases = state?.aliases ?? [];

  const items = useMemo(
    () =>
      snapshot
        ? buildTranscript({
            hasState: state !== null,
            connectionTrouble: snapshot.live === "closed",
            messages: state?.messages ?? [],
            plans: state?.plans ?? [],
            aliases,
            activeRun: state?.activeRun ?? null,
            runWaitingForMac: state?.activeRun?.status === "queued" && !canRunChat(presence),
            isOnline: presence?.online ?? true,
            expandedSteps: snapshot.expandedSteps,
            busyPlans: snapshot.busyPlans,
            busyQuestions: snapshot.busyQuestions,
            busyConsents: snapshot.busyConsents,
            queue: snapshot.queue,
            stepStarts: snapshot.stepStarts,
          })
        : [],
    [snapshot, state, aliases, presence],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-chat-panel="">
      {!controller ? (
        <div className="scroll-area min-h-0 flex-1 px-4 pt-5 pb-4">
          <span className="flex size-9 items-center justify-center rounded-full bg-control text-icon">
            <IconChat size={16} strokeWidth={1.5} />
          </span>
          <h3 className="mt-3 text-body-lg font-semibold text-fg">Bu post hakkında sohbet</h3>
          <p className="mt-1.5 text-body text-fg-2">
            Yazdıkların bu posta bağlı bir sohbette kalır. Tuvalde seçtiğin katmanlar (ya da @ ile
            seçtiklerin) isteğin kapsamı olur; AI'nin yaptığı değişiklikler yeni sürüm olarak tuvale
            gelir.
          </p>
          <div className="mt-4 flex flex-col items-start gap-1.5">
            {STARTERS.map((s) => (
              <Chip key={s} onClick={() => onStarter(s)}>
                {s}
              </Chip>
            ))}
          </div>
        </div>
      ) : (
        <div
          ref={follow.scroller}
          onScroll={follow.onScroll}
          onWheel={follow.onWheel}
          className="scroll-area min-h-0 flex-1 overflow-x-hidden [overflow-anchor:none]"
        >
          <div ref={follow.content} className="px-4 pt-4 pb-6 [&_.max-w-\[78\%\]]:max-w-[88%]">
            <TranscriptItems
              items={items}
              aliases={aliases}
              controller={controller}
              brandId={state?.conversation.brandId ?? null}
              onFocusScroll={follow.pause}
              onMention={(aliasId) => {
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
              }}
              onEditPlan={() => onStarter("")}
              onEditQueued={(text) => onStarter(text)}
            />
          </div>
        </div>
      )}
      <div className="relative shrink-0 border-t border-hairline px-1.5 py-1">
        {follow.jump && controller && (
          <JumpToLatest working={chat.working} onClick={() => follow.resume(true)} />
        )}
        {snapshot?.error && (
          <div
            className="flex items-center gap-2 px-2.5 py-1 text-footnote text-danger"
            role="alert"
          >
            <span className="min-w-0 flex-1">{snapshot.error}</span>
            <button
              type="button"
              aria-label="Kapat"
              onClick={() => controller?.clearError()}
              className="text-fg-2 hover:text-fg"
            >
              <IconClose size={12} />
            </button>
          </div>
        )}
        {chat.setChoice ? (
          <StatusLine choice={chat.choice} onChoice={chat.setChoice} presence={presence} />
        ) : (
          <p className={cn("flex h-6 items-center px-2.5 text-footnote text-fg-3")}>
            {presence ? (presence.online ? "Mac hazır" : "Mac çevrimdışı") : "Sohbet"}
          </p>
        )}
      </div>
    </div>
  );
}

/** The panel header on Sohbet: its title, and open the chat full size / start over. */
export function ChatHeader({ chat, title }: { chat: PostChat; title: string }) {
  const navigate = useAppStore((s) => s.navigate);
  const id = chat.conversationId;
  return (
    <>
      <h2 className="min-w-0 flex-1 truncate text-body font-medium text-fg">
        Sohbet <span className="font-normal text-fg-3">· {title}</span>
      </h2>
      {id && (
        <MenuButton
          label="Sohbet işlemleri"
          placement="bottom-end"
          width={230}
          entries={[
            {
              id: "open",
              label: "Sohbette tam ekran aç",
              onSelect: () => navigate({ kind: "conversation", id }),
            },
            {
              id: "restart",
              label: "Bu post için yeni sohbet",
              disabled: chat.working,
              onSelect: () => chat.restart(),
            },
          ]}
        >
          {({ ref, onClick, onKeyDown, open, ...aria }) => (
            <IconButton
              ref={ref}
              icon={<IconEllipsis size={16} strokeWidth={1.5} />}
              label="Sohbet işlemleri"
              selected={open}
              onClick={onClick}
              onKeyDown={onKeyDown}
              {...aria}
            />
          )}
        </MenuButton>
      )}
    </>
  );
}
