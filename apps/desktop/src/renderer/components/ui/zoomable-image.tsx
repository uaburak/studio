// The one way a picture opens in the image viewer (chat/lightbox.tsx). `useImageZoom(images)`
// keeps a group's thumbnails (a chat grid, the media library) and opens the viewer on one of
// them, the picture zooming out of its thumbnail and back; `<ZoomableImage>` is a clickable
// thumbnail — alone, or one of a group (‹ n / m › pages through the group).
import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { imageUrl } from "../../lib/api.ts";
import type { ChatImage } from "../../lib/transcript.ts";
import { useAppStore } from "../../state/app-store.ts";

export interface ImageZoom {
  /** Ref for image `index`'s thumbnail: its `<img>`, or a tile holding it. */
  ref(index: number): (el: Element | null) => void;
  /** Opens the viewer on image `index` of the group. */
  open(index: number): void;
}

export function useImageZoom(images: readonly ChatImage[]): ImageZoom {
  const sources = useRef(new Map<number, Element>()).current;
  return {
    ref: (index) => (el) => {
      if (el) sources.set(index, el);
      else sources.delete(index);
    },
    open: (index) =>
      useAppStore.getState().openLightbox({
        images: [...images],
        index,
        sourceOf: (i) => sources.get(i) ?? null,
      }),
  };
}

/** A thumbnail button that opens its picture in the viewer. `children` lie over the picture
 *  (hover dim, badges); `imgClassName` sizes the picture (default: covers the button). */
export function ZoomableImage({
  image,
  zoom,
  index = 0,
  label,
  alt = image.caption ?? "",
  className,
  imgClassName = "size-full object-cover",
  style,
  loading,
  children,
}: {
  image: ChatImage;
  /** The group it belongs to; without one it opens alone. */
  zoom?: ImageZoom;
  index?: number;
  label?: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
  children?: ReactNode;
}) {
  const alone = useImageZoom([image]);
  const group = zoom ?? alone;
  const at = zoom ? index : 0;
  return (
    <button
      type="button"
      title={image.caption ?? undefined}
      aria-label={label ?? (image.caption ? `Görseli aç: ${image.caption}` : "Görseli aç")}
      onClick={(event) => {
        event.stopPropagation();
        group.open(at);
      }}
      className={className}
      style={style}
    >
      <img
        ref={group.ref(at)}
        src={imageUrl(image)}
        alt={alt}
        draggable={false}
        loading={loading}
        className={imgClassName}
      />
      {children}
    </button>
  );
}
