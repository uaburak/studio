// One tile of the profile grid (like an Instagram profile and the iPhone's Profil): the rendered
// picture edge to edge (or the post's title on its tone while it has none), a status dot at the
// top left, a carousel / Reels mark at the top right and the badges ("+ Görsel", "Üretiliyor",
// "Üretilemedi"). Hover (or selection) shows İndir and "…" (the tile's menu, also on a right
// click). ⌘-click / ⇧-click pick tiles for the bulk bar (N1); a failed generation offers
// "Yeniden dene" (A3). Memoized: a tile draws again only when its own data (or its picked /
// selected state) changes.
import { forwardRef, memo } from "react";
import { cn, IconButton, Spinner } from "../../components/ui/controls.tsx";
import { IconCheck, IconRetry } from "../../components/ui/icons.tsx";
import {
  InstaCarousel,
  InstaDownload,
  InstaOptions,
  InstaReels,
} from "../../components/ui/insta-icons.tsx";
import { thumbUrl } from "../../lib/thumbnail.ts";
import {
  cardMetaText,
  cardState,
  generationFailure,
  isActiveJob,
  type PostCard,
  STATE_DOT,
  STATE_LABEL,
} from "./board.ts";
import { failureText } from "./failure.ts";
import { coverAssetId, PLACEHOLDER_GRADIENTS, stableIndex } from "./post-media.tsx";

export interface PostCardActions {
  /** A plain click. `event` carries ⌘ / ⇧ (picking for the bulk bar) when there is one. */
  open(card: PostCard, origin: DOMRect | null, event?: React.MouseEvent): void;
  /** `source`: the tile's picture (the viewer zooms out of it). */
  quickLook(card: PostCard, source: Element | null): void;
  copyCaption(card: PostCard): void;
  duplicate(card: PostCard): void;
  remove(card: PostCard): void;
  /** "İndir": the post's pictures (a reel: its video) to a folder the owner picks. */
  download?(card: PostCard): void;
  /** "Yeniden dene" of a failed generation. */
  retry?(card: PostCard, jobId: string): void;
  /** The tile's menu at the pointer (right click, or the "…" button). */
  contextMenu?(card: PostCard, event: React.MouseEvent): void;
}

/** CSS width a tile is about (three columns of the ~960 px profile): thumbnails are asked at it. */
const TILE_WIDTH = 320;

const PostCardBody = forwardRef<
  HTMLLIElement,
  {
    card: PostCard;
    brandName?: string | undefined;
    selected?: boolean;
    /** Picked for the bulk bar. */
    picked?: boolean;
    /** CSS aspect ratio of the tile ("3 / 4" posts, "9 / 16" Reels and stories). */
    aspect?: string;
    actions: PostCardActions;
  }
>(function PostCardView(
  { card, brandName, selected = false, picked = false, aspect = "3 / 4", actions },
  ref,
) {
  const state = cardState(card);
  const busy = isActiveJob(card.job) && state !== "generating";
  const failure = busy ? null : generationFailure(card);
  const reason = failure ? failureText(failure.error) : null;
  const slides = card.version?.slides.length ?? 0;
  const isReel = card.content.type === "reel";
  const carousel = !isReel && (card.content.type === "carousel" || slides > 1);
  const picture = coverAssetId(card.version, isReel);
  const dot = STATE_DOT[state];
  const meta = cardMetaText(card);
  /** A generated picture of the post waits for the owner's word (docs/URETIM-RESIM.md §12). */
  const awaiting = (card.content.pendingApprovals ?? 0) > 0;
  const media = (el: Element | null) => el?.closest("li")?.querySelector("[data-media]") ?? null;
  const mediaRect = (el: Element | null) => media(el)?.getBoundingClientRect() ?? null;
  const badge =
    busy || state === "generating"
      ? { spin: true, text: state === "generating" ? "Üretiliyor" : "Render ediliyor" }
      : state === "imageNeeded"
        ? { spin: false, text: "+ Görsel" }
        : null;
  return (
    <li
      ref={ref}
      data-card-id={card.id}
      data-selected={selected || undefined}
      data-picked={picked || undefined}
      aria-current={selected || undefined}
      onContextMenu={(event) => actions.contextMenu?.(card, event)}
      className="group relative overflow-hidden bg-field [content-visibility:auto] [contain-intrinsic-size:auto_320px]"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Postu aç: ${card.content.title}`}
        title={`${card.content.title}\n${meta} · ${STATE_LABEL[state]}${awaiting ? " · Onay bekliyor" : ""}`}
        onClick={(event) => actions.open(card, mediaRect(event.currentTarget), event)}
        className="block w-full text-left"
      >
        <span data-media="" className="relative block w-full" style={{ aspectRatio: aspect }}>
          {picture ? (
            <img
              src={thumbUrl(picture, TILE_WIDTH)}
              alt=""
              draggable={false}
              loading="lazy"
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <span
              className="absolute inset-0 flex flex-col p-3 pt-7"
              style={{
                background:
                  PLACEHOLDER_GRADIENTS[stableIndex(card.id, PLACEHOLDER_GRADIENTS.length)],
              }}
            >
              {brandName && (
                <span className="truncate text-[10px] font-semibold tracking-[1px] text-white/80 uppercase">
                  {brandName}
                </span>
              )}
              <span className="mt-auto line-clamp-4 text-[15px] leading-5 font-bold text-white [overflow-wrap:anywhere]">
                {card.content.title}
              </span>
            </span>
          )}
          <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-150 group-hover:bg-black/15" />
          {/* Selected (arrows) and picked (⌘ / ⇧): a ring inside the tile, as the grid has no gaps. */}
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0",
              selected && "shadow-[inset_0_0_0_2px_var(--text-primary)]",
              picked && "shadow-[inset_0_0_0_3px_var(--accent-default)]",
            )}
          />
          {picked ? (
            <span className="absolute top-2 left-2 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
              <IconCheck size={12} strokeWidth={2.5} />
            </span>
          ) : (
            dot && (
              <span
                aria-hidden="true"
                className="absolute top-2.5 left-2.5 size-2.5 rounded-full shadow-[0_0_0_1.5px_white,0_1px_3px_rgb(0_0_0/0.35)]"
                style={{ background: dot }}
              />
            )
          )}
          {(isReel || carousel) && (
            <span className="absolute top-2 right-2 text-white drop-shadow-[0_0_3px_rgb(0_0_0/0.45)] transition-opacity duration-150 group-hover:opacity-0 group-data-[selected]:opacity-0">
              {isReel ? <InstaReels size={18} /> : <InstaCarousel size={18} />}
            </span>
          )}
          {badge && (
            <span className="absolute bottom-2 left-2 flex h-6 items-center gap-1.5 rounded-full bg-black/60 px-2 text-caption font-semibold text-white">
              {badge.spin && <Spinner size={11} />}
              {badge.text}
            </span>
          )}
          {awaiting && !badge && !failure && (
            <span className="absolute bottom-2 left-2 flex h-6 items-center gap-1.5 rounded-full bg-black/60 px-2 text-caption font-semibold text-white">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              Onay bekliyor
            </span>
          )}
          {failure && reason && (
            <span
              className="absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-16px)] items-center rounded-full bg-danger px-2 text-caption font-semibold text-white"
              title={reason.detail ?? reason.text}
            >
              <span className="truncate">
                {state === "generationFailed" ? "Üretilemedi" : "Son üretim başarısız"}
              </span>
            </span>
          )}
          <span className="sr-only">{meta}</span>
          {state !== "generationFailed" && <span className="sr-only">{STATE_LABEL[state]}</span>}
          {reason && <span className="sr-only">{reason.text}</span>}
        </span>
      </button>
      {failure && actions.retry && (
        <button
          type="button"
          onClick={() => actions.retry?.(card, failure.jobId)}
          className="absolute right-2 bottom-2 flex h-6 items-center gap-1 rounded-full bg-white/90 px-2 text-footnote text-black hover:bg-white"
        >
          <IconRetry size={12} strokeWidth={1.75} />
          Yeniden dene
        </button>
      )}
      <div
        role="toolbar"
        aria-label="Post işlemleri"
        className={cn(
          "glass absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full p-0.5",
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-data-[selected]:opacity-100 focus-within:opacity-100",
        )}
      >
        {actions.download && (
          <IconButton
            icon={<InstaDownload size={15} />}
            label="İndir"
            size={24}
            disabled={!card.version}
            onClick={() => actions.download?.(card)}
          />
        )}
        {actions.contextMenu && (
          <IconButton
            icon={<InstaOptions size={18} />}
            label="Diğer işlemler"
            size={24}
            onClick={(event) => actions.contextMenu?.(card, event)}
          />
        )}
      </div>
    </li>
  );
});

export const PostCardView = memo(PostCardBody);
