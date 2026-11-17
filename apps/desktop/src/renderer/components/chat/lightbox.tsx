// Full-window image viewer (Wecra "Lightbox"): the window dims (scrim 85 %), the image zooms
// from its thumbnail to the centre, "‹ 2 / 5 ›" at the bottom with the caption on the left and
// download / copy on the right, ✕ top right. ←/→ page, Space or double-click zooms (drag pans),
// Esc or a click outside closes (zooming back into the thumbnail).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { imageUrl } from "../../lib/api.ts";
import {
  canGoNext,
  canGoPrev,
  counterText,
  fitRect,
  flipTransform,
  type LightboxState,
  lightboxKey,
  type Rect,
  reduceLightbox,
} from "../../lib/lightbox.ts";
import { useAppStore } from "../../state/app-store.ts";
import { cn, IconButton } from "../ui/controls.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconDownload,
} from "../ui/icons.tsx";

type Phase = "opening" | "open" | "closing";

export function Lightbox() {
  const request = useAppStore((s) => s.lightbox);
  const close = useAppStore((s) => s.closeLightbox);
  if (!request) return null;
  return <LightboxView key={request.images.map((i) => i.assetId).join(",")} onDone={close} />;
}

function LightboxView({ onDone }: { onDone(): void }) {
  const request = useAppStore((s) => s.lightbox);
  const images = request?.images ?? [];
  const [state, setState] = useState<LightboxState>({
    index: request?.index ?? 0,
    count: images.length,
    zoomed: false,
  });
  const [phase, setPhase] = useState<Phase>("opening");
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [natural, setNatural] = useState<Record<string, { width: number; height: number }>>({});
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const image = images[state.index];

  const size = image
    ? (natural[image.assetId] ??
      (image.width && image.height
        ? { width: image.width, height: image.height }
        : { width: 4, height: 5 }))
    : { width: 1, height: 1 };
  const fit = fitRect(size, viewport);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Opening: start at the thumbnail frame, then animate to the fitted frame.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")));
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = useCallback(() => {
    if (phase === "closing") return;
    setPhase("closing");
    setTimeout(onDone, 260);
  }, [onDone, phase]);

  const dispatch = useCallback(
    (action: Parameters<typeof reduceLightbox>[1]) => {
      const next = reduceLightbox(state, action);
      if (next === null) finish();
      else {
        if (!next.zoomed) setPan({ x: 0, y: 0 });
        setState(next);
      }
    },
    [state, finish],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = lightboxKey(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch]);

  if (!request || !image) return null;

  const origin: Rect | null =
    phase === "closing"
      ? (request.originOf?.(state.index) ?? null)
      : phase === "opening"
        ? request.origin
        : null;
  const transform = origin
    ? flipTransform(origin, fit)
    : state.zoomed
      ? `translate(${pan.x}px, ${pan.y}px) scale(2)`
      : "none";
  const fading = (phase === "opening" || phase === "closing") && !origin;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Görsel"
      className="fixed inset-0 z-[100]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-scrim transition-opacity duration-300 ease-snap"
        style={{ opacity: phase === "open" ? 1 : 0 }}
      />
      <img
        key={image.assetId}
        src={imageUrl(image)}
        alt={image.caption ?? ""}
        draggable={false}
        onLoad={(event) => {
          const el = event.currentTarget;
          if (!natural[image.assetId]) {
            setNatural((n) => ({
              ...n,
              [image.assetId]: { width: el.naturalWidth, height: el.naturalHeight },
            }));
          }
        }}
        onDoubleClick={() => dispatch({ kind: "toggleZoom" })}
        onPointerDown={(event) => {
          if (!state.zoomed) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setPan({
            x: drag.current.panX + event.clientX - drag.current.x,
            y: drag.current.panY + event.clientY - drag.current.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        className={cn(
          "absolute rounded-[12px] object-cover shadow-lg select-none",
          state.zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
          drag.current ? "" : "transition-[transform,opacity] duration-300 ease-snap",
        )}
        style={{
          left: fit.x,
          top: fit.y,
          width: fit.width,
          height: fit.height,
          transform,
          transformOrigin: origin ? "0 0" : "center",
          opacity: fading ? 0 : 1,
        }}
      />
      <div
        className="absolute top-3.5 right-3.5 transition-opacity duration-200"
        style={{ opacity: phase === "open" ? 1 : 0 }}
      >
        <IconButton
          icon={<IconClose size={16} strokeWidth={1.75} />}
          label="Kapat"
          shortcut="Esc"
          className="text-white hover:bg-white/10"
          onClick={finish}
        />
      </div>
      <div
        className="absolute inset-x-0 bottom-0 flex h-[60px] items-center px-6 text-footnote text-white/80 transition-opacity duration-200"
        style={{ opacity: phase === "open" ? 1 : 0 }}
      >
        <span className="w-1/3 truncate">{image.caption}</span>
        <div className="flex w-1/3 items-center justify-center gap-4">
          {state.count > 1 && (
            <>
              <IconButton
                icon={<IconChevronLeft size={16} strokeWidth={1.75} />}
                label="Önceki"
                shortcut="←"
                disabled={!canGoPrev(state)}
                className="text-white hover:bg-white/10"
                onClick={() => dispatch({ kind: "prev" })}
              />
              <span className="min-w-[44px] text-center text-body text-white tabular-nums">
                {counterText(state)}
              </span>
              <IconButton
                icon={<IconChevronRight size={16} strokeWidth={1.75} />}
                label="Sonraki"
                shortcut="→"
                disabled={!canGoNext(state)}
                className="text-white hover:bg-white/10"
                onClick={() => dispatch({ kind: "next" })}
              />
            </>
          )}
        </div>
        <div className="flex w-1/3 items-center justify-end gap-1">
          <a
            href={imageUrl(image)}
            download
            aria-label="İndir"
            className="no-drag flex size-7 items-center justify-center rounded-full text-white hover:bg-white/10"
          >
            <IconDownload size={16} strokeWidth={1.75} />
          </a>
          <IconButton
            icon={<IconCopy size={15} strokeWidth={1.75} />}
            label="Görseli kopyala"
            className="text-white hover:bg-white/10"
            onClick={() => void copyImage(imageUrl(image))}
          />
        </div>
      </div>
    </div>
  );
}

async function copyImage(url: string): Promise<void> {
  try {
    const blob = await (await fetch(url)).blob();
    if (typeof ClipboardItem !== "undefined" && blob.type === "image/png") {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      useAppStore.getState().showToast({ message: "Görsel kopyalandı" });
      return;
    }
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (png) await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    useAppStore.getState().showToast({ message: "Görsel kopyalandı" });
  } catch {
    useAppStore.getState().showToast({ message: "Görsel kopyalanamadı", tone: "danger" });
  }
}
