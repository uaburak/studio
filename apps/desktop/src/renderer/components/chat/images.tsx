// Images in the chat (Wecra "Image tile"): rounded thumbnails; one image up to 480 pt wide,
// several in a tidy grid with 6 pt gaps; hover dims and shows an expand mark; click opens the
// lightbox zooming from the thumbnail.
import { useRef } from "react";
import { imageUrl } from "../../lib/api.ts";
import type { ChatImage } from "../../lib/transcript.ts";
import { useAppStore } from "../../state/app-store.ts";
import { cn } from "../ui/controls.tsx";
import { IconExpand } from "../ui/icons.tsx";

function rectOf(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function aspectOf(image: ChatImage, fallback = 4 / 5): number {
  return image.width && image.height ? image.width / image.height : fallback;
}

export function ImageGrid({ images, className }: { images: ChatImage[]; className?: string }) {
  const openLightbox = useAppStore((s) => s.openLightbox);
  const tiles = useRef(new Map<number, HTMLButtonElement>());
  if (images.length === 0) return null;
  const single = images.length === 1;
  const open = (index: number) =>
    openLightbox({
      images,
      index,
      origin: rectOf(tiles.current.get(index)),
      originOf: (i) => rectOf(tiles.current.get(i)),
    });
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {images.map((image, index) => {
        const aspect = aspectOf(image);
        const width = single ? Math.min(480, aspect >= 1 ? 480 : 360 * aspect) : 168;
        return (
          <button
            key={`${image.assetId}-${index}`}
            ref={(el) => {
              if (el) tiles.current.set(index, el);
              else tiles.current.delete(index);
            }}
            type="button"
            title={image.caption ?? undefined}
            aria-label={image.caption ? `Görseli aç: ${image.caption}` : "Görseli aç"}
            onClick={() => open(index)}
            className="group relative overflow-hidden rounded-[12px] bg-control"
            style={{ width, aspectRatio: String(aspect) }}
          >
            <img
              src={imageUrl(image)}
              alt={image.caption ?? ""}
              draggable={false}
              loading="lazy"
              className="size-full object-cover"
            />
            <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/20" />
            <span className="pointer-events-none absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <IconExpand size={12} strokeWidth={2} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Small thumbnails at the right end of a finished step line (≈34×22). */
export function StepThumbnails({ images }: { images: ChatImage[] }) {
  const openLightbox = useAppStore((s) => s.openLightbox);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  if (images.length === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
      {images.slice(0, 4).map((image, index) => (
        <button
          key={image.assetId}
          ref={(el) => {
            if (el) refs.current.set(index, el);
            else refs.current.delete(index);
          }}
          type="button"
          title={image.caption ?? undefined}
          onClick={(event) => {
            event.stopPropagation();
            openLightbox({
              images,
              index,
              origin: rectOf(refs.current.get(index)),
              originOf: (i) => rectOf(refs.current.get(i)),
            });
          }}
          className="h-[22px] w-[34px] overflow-hidden rounded-[4px] bg-control shadow-[inset_0_0_0_1px_var(--border-hairline)]"
        >
          <img src={imageUrl(image)} alt="" draggable={false} className="size-full object-cover" />
        </button>
      ))}
    </span>
  );
}
