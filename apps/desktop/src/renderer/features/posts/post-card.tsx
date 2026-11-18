// One card of the posts board (Wecra "Post card"): 4:5 media (render, or the placeholder),
// title, platform · date and the status tag. Hover (or selection) shows the quick actions
// over the media: Hızlı bakış, Açıklamayı kopyala, Çoğalt, Sil. ⌘-click / ⇧-click pick cards for
// the bulk bar (N1); a failed generation shows its reason and "Yeniden dene" (A3).
// Memoized: a card draws again only when its own data (or its picked / selected state) changes.
import { forwardRef, memo } from "react";
import { cn, IconButton, Spinner, TagPill } from "../../components/ui/controls.tsx";
import {
  IconCheck,
  IconCopy,
  IconDuplicate,
  IconEye,
  IconRetry,
  IconTrash,
} from "../../components/ui/icons.tsx";
import {
  cardMetaText,
  cardState,
  deletionBlocker,
  generationFailure,
  isActiveJob,
  type PostCard,
  renderedAssetIds,
  STATE_LABEL,
  STATE_TONE,
} from "./board.ts";
import { failureText } from "./failure.ts";
import { PostMedia } from "./post-media.tsx";

export interface PostCardActions {
  /** A plain click. `event` carries ⌘ / ⇧ (picking for the bulk bar) when there is one. */
  open(card: PostCard, origin: DOMRect | null, event?: React.MouseEvent): void;
  /** `source`: the card's picture (the viewer zooms out of it). */
  quickLook(card: PostCard, source: Element | null): void;
  copyCaption(card: PostCard): void;
  duplicate(card: PostCard): void;
  remove(card: PostCard): void;
  /** "Yeniden dene" of a failed generation. */
  retry?(card: PostCard, jobId: string): void;
  contextMenu?(card: PostCard, event: React.MouseEvent): void;
}

const PostCardBody = forwardRef<
  HTMLLIElement,
  {
    card: PostCard;
    brandName?: string | undefined;
    selected?: boolean;
    /** Picked for the bulk bar. */
    picked?: boolean;
    actions: PostCardActions;
  }
>(function PostCardView({ card, brandName, selected = false, picked = false, actions }, ref) {
  const state = cardState(card);
  const busy = isActiveJob(card.job) && state !== "generating";
  const failure = busy ? null : generationFailure(card);
  const reason = failure ? failureText(failure.error) : null;
  const slides = card.version?.slides.length ?? 0;
  const blocker = deletionBlocker(card.content);
  const hasRenders = renderedAssetIds(card).length > 0;
  const media = (el: Element | null) => el?.closest("li")?.querySelector("[data-media]") ?? null;
  const mediaRect = (el: Element | null) => media(el)?.getBoundingClientRect() ?? null;
  return (
    <li
      ref={ref}
      data-card-id={card.id}
      data-selected={selected || undefined}
      data-picked={picked || undefined}
      aria-current={selected || undefined}
      onContextMenu={(event) => actions.contextMenu?.(card, event)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[12px] bg-field shadow-[inset_0_0_0_1px_var(--border-hairline)]",
        "transition-shadow duration-150 [content-visibility:auto] [contain-intrinsic-size:auto_360px]",
        "data-[selected]:shadow-[inset_0_0_0_1px_var(--border-hairline),0_0_0_2px_var(--bg-page),0_0_0_4px_var(--text-primary)]",
        "data-[picked]:shadow-[inset_0_0_0_1px_var(--border-hairline),0_0_0_2px_var(--bg-page),0_0_0_4px_var(--accent-default)]",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Postu aç: ${card.content.title}`}
        onClick={(event) => actions.open(card, mediaRect(event.currentTarget), event)}
        className="flex flex-col text-left"
      >
        <span data-media="" className="relative block aspect-[4/5] w-full">
          <PostMedia
            contentId={card.id}
            title={card.content.title}
            brandName={brandName}
            version={card.version}
            isReel={card.content.type === "reel"}
            className="absolute inset-0"
          />
          <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/10" />
          {picked && (
            <span className="absolute top-2.5 left-2.5 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
              <IconCheck size={12} strokeWidth={2.5} />
            </span>
          )}
          {slides > 1 && (
            <span className="absolute top-2.5 right-2.5 flex h-5 items-center rounded-full bg-black/45 px-1.5 text-caption text-white transition-opacity duration-150 group-hover:opacity-0 group-data-[selected]:opacity-0">
              1/{slides}
            </span>
          )}
          {(busy || state === "generating") && (
            <span className="absolute bottom-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-black/55 px-2 text-caption text-white">
              <Spinner size={11} />
              {state === "generating" ? "Üretiliyor" : "Render ediliyor"}
            </span>
          )}
        </span>
        <span className="flex flex-col gap-2 p-3">
          <span className="truncate text-body font-medium text-fg">{card.content.title}</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-footnote text-fg-2">
              {cardMetaText(card)}
            </span>
            <TagPill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</TagPill>
          </span>
        </span>
      </button>
      {failure && reason && (
        <div className="-mt-1 flex items-start gap-2 px-3 pb-3">
          <span
            className="line-clamp-2 min-w-0 flex-1 text-footnote text-danger"
            title={reason.detail ?? undefined}
          >
            {state === "generationFailed" ? reason.text : `Son üretim başarısız: ${reason.text}`}
          </span>
          {actions.retry && (
            <button
              type="button"
              onClick={() => actions.retry?.(card, failure.jobId)}
              className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-control px-2 text-footnote text-fg hover:bg-control-hover"
            >
              <IconRetry size={12} strokeWidth={1.75} />
              Yeniden dene
            </button>
          )}
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Post işlemleri"
        className={cn(
          "glass absolute top-2 right-2 flex items-center gap-0.5 rounded-full p-0.5",
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-data-[selected]:opacity-100 focus-within:opacity-100",
        )}
      >
        <IconButton
          icon={<IconEye size={14} strokeWidth={1.75} />}
          label="Hızlı bakış"
          shortcut="Boşluk"
          size={24}
          disabled={!hasRenders}
          onClick={(event) => actions.quickLook(card, media(event.currentTarget))}
        />
        <IconButton
          icon={<IconCopy size={13} strokeWidth={1.75} />}
          label="Açıklamayı kopyala"
          size={24}
          disabled={!card.content.caption.trim()}
          onClick={() => actions.copyCaption(card)}
        />
        <IconButton
          icon={<IconDuplicate size={14} strokeWidth={1.75} />}
          label="Çoğalt"
          shortcut="⌘D"
          size={24}
          onClick={() => actions.duplicate(card)}
        />
        <IconButton
          icon={<IconTrash size={14} strokeWidth={1.75} />}
          label={blocker ?? "Sil"}
          shortcut={blocker ? undefined : "⌫"}
          size={24}
          disabled={!!blocker}
          onClick={() => actions.remove(card)}
        />
      </div>
    </li>
  );
});

export const PostCardView = memo(PostCardBody);
