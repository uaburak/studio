// Images in the chat (Wecra "Image tile"): rounded thumbnails; one image up to 480 pt wide,
// several in a tidy grid with 6 pt gaps; hover dims and shows an expand mark; click opens the
// viewer, the picture zooming out of its thumbnail.
import type { ChatImage } from "../../lib/transcript.ts";
import { cn } from "../ui/controls.tsx";
import { IconExpand } from "../ui/icons.tsx";
import { useImageZoom, ZoomableImage } from "../ui/zoomable-image.tsx";

export function aspectOf(image: ChatImage, fallback = 4 / 5): number {
  return image.width && image.height ? image.width / image.height : fallback;
}

export function ImageGrid({ images, className }: { images: ChatImage[]; className?: string }) {
  const zoom = useImageZoom(images);
  if (images.length === 0) return null;
  const single = images.length === 1;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {images.map((image, index) => {
        const aspect = aspectOf(image);
        const width = single ? Math.min(480, aspect >= 1 ? 480 : 360 * aspect) : 168;
        return (
          <ZoomableImage
            key={`${image.assetId}-${index}`}
            image={image}
            zoom={zoom}
            index={index}
            loading="lazy"
            className="group relative overflow-hidden rounded-[12px] bg-control"
            style={{ width, aspectRatio: String(aspect) }}
          >
            <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/20" />
            <span className="pointer-events-none absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <IconExpand size={12} strokeWidth={2} />
            </span>
          </ZoomableImage>
        );
      })}
    </div>
  );
}

/** Small thumbnails at the right end of a finished step line (≈34×22). */
export function StepThumbnails({ images }: { images: ChatImage[] }) {
  const zoom = useImageZoom(images);
  if (images.length === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
      {images.slice(0, 4).map((image, index) => (
        <ZoomableImage
          key={image.assetId}
          image={image}
          zoom={zoom}
          index={index}
          alt=""
          className="h-[22px] w-[34px] overflow-hidden rounded-[4px] bg-control shadow-[inset_0_0_0_1px_var(--border-hairline)]"
        />
      ))}
    </span>
  );
}
