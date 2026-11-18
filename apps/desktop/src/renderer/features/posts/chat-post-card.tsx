// A post the agent referred to in a reply (`content_ref`): title, status and the note on one
// row, the rendered slides under it. Any of them opens the post over the centre.

import { Spinner, TagPill } from "../../components/ui/controls.tsx";
import { IconChevronRight, IconGrid, IconWarning } from "../../components/ui/icons.tsx";
import { Card } from "../../components/ui/popover.tsx";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { cardState, type PostCard, STATE_LABEL, STATE_TONE } from "./board.ts";
import { useContent, useVersion } from "./data.ts";
import { coverAssetId, PostMedia } from "./post-media.tsx";
import { openPostDetail } from "./store.ts";

export const CHAT_MAX_SLIDES = 6;

export function ChatPostCard({
  contentId,
  version: refVersion,
  note,
}: {
  contentId: string;
  /** Version the reply referred to (named; the card shows the current version). */
  version?: number | null;
  note: string | null;
}) {
  const content = useContent(contentId);
  // The slides of the current version (like the Mac): an edit after the reply shows up here.
  const version = useVersion(contentId, content.data?.currentVersion?.version);

  if (content.isLoading) {
    return (
      <Card className="my-3.5 flex h-11 items-center gap-2 px-3.5 text-body text-fg-2">
        <Spinner size={13} /> Post yükleniyor…
      </Card>
    );
  }
  if (!content.data) {
    // Only a 404 means the post is gone; a server that is down or failed says so instead.
    const gone = (content.error as { status?: unknown } | null)?.status === 404;
    const text = gone
      ? "Post bulunamadı"
      : content.isError
        ? "Post şu an yüklenemedi"
        : "Post, sunucu açılınca görünecek";
    return (
      <Card className="my-3.5 flex h-11 items-center gap-2 px-3.5 text-body text-fg-2">
        <IconWarning size={14} className="text-fg-3" />
        {text}
        {note ? ` · ${note}` : ""}
      </Card>
    );
  }
  const c = content.data;
  const v = version.data ?? null;
  const card: PostCard = {
    id: c.id,
    content: c,
    version: v,
    planItem: null,
    schedule: null,
    job: null,
  };
  const state = cardState(card);
  const isReel = c.type === "reel";
  const slides = (v?.slides ?? []).slice(0, CHAT_MAX_SLIDES);
  const extra = (v?.slides.length ?? 0) - slides.length;
  const open = () => openPostDetail(c.id);

  return (
    <Card className="my-3.5 flex w-fit max-w-full min-w-[280px] flex-col gap-2.5 p-3">
      <button
        type="button"
        onClick={open}
        aria-label={`Postu aç: ${c.title}`}
        className="group flex min-w-0 items-center gap-2 rounded-full text-left"
      >
        <IconGrid size={14} strokeWidth={1.5} className="shrink-0 text-icon" />
        <span className="min-w-0 truncate text-body font-medium text-fg group-hover:underline">
          {c.title}
        </span>
        <IconChevronRight size={12} strokeWidth={1.75} className="shrink-0 text-fg-3" />
        <TagPill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</TagPill>
        {(note || refVersion) && (
          <span className="min-w-0 truncate text-footnote text-fg-2">
            {[refVersion ? `v${refVersion}` : null, note].filter(Boolean).join(" · ")}
          </span>
        )}
      </button>
      <div className="flex flex-wrap gap-1.5">
        {isReel || slides.length === 0 ? (
          <button
            type="button"
            onClick={open}
            aria-label="Postu aç"
            className="overflow-hidden rounded-[8px]"
          >
            <PostMedia
              contentId={c.id}
              title={c.title}
              version={v}
              isReel={isReel}
              size="thumb"
              className="relative h-[120px] w-[96px]"
            />
          </button>
        ) : (
          slides.map((slide, index) => (
            <button
              key={`${index}-${slide.renderedAssetId ?? ""}`}
              type="button"
              onClick={open}
              aria-label={`Slayt ${index + 1}`}
              className="relative h-[120px] w-[96px] overflow-hidden rounded-[8px] bg-control shadow-[inset_0_0_0_1px_var(--border-hairline)]"
            >
              {slide.renderedAssetId ? (
                <img
                  src={thumbUrl(slide.renderedAssetId, 96)}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex size-full items-center justify-center">
                  <Spinner size={12} />
                </span>
              )}
              {index === slides.length - 1 && extra > 0 && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-body font-medium text-white">
                  +{extra}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {coverAssetId(v, isReel) === null && slides.length === 0 && !isReel && (
        <span className="text-footnote text-fg-3">Tasarım henüz hazır değil.</span>
      )}
    </Card>
  );
}
