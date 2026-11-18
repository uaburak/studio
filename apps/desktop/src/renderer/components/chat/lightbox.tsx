// Full-window image viewer (Wecra "Lightbox") with the Photos zoom: the picture grows out of its
// thumbnail — same place, size, crop and corner radius — into the fitted frame while the window
// dims (scrim 85 %), and shrinks back into it on close; with no thumbnail on screen (gone,
// scrolled away) it fades instead. Drag it down to dismiss: it follows and shrinks while the scrim
// clears; let go far enough (or flick) and it closes, else it springs back. "‹ 2 / 5 ›" at the
// bottom with the caption on the left and download / copy on the right, ✕ top right; ←/→ page,
// Space or double-click zooms (drag pans), Esc, ✕ or a click outside closes.
//
// The frame animates its real box (left/top/width/height + corner radii) and the picture always
// covers it, so the crop morphs from the thumbnail's to the whole picture without stretching.
// Drag and zoom are transforms on top, folded into the box when it closes. Thumbnails come from
// `useImageZoom` / `<ZoomableImage>` (ui/zoomable-image.tsx).
import {
  AnimatePresence,
  animate,
  type MotionValue,
  motion,
  motionValue,
  usePresence,
  useReducedMotion,
  type ValueAnimationTransition,
} from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { imageUrl } from "../../lib/api.ts";
import {
  bakeTransform,
  canGoNext,
  canGoPrev,
  counterText,
  dismissDrag,
  type Frame,
  fitRect,
  type LightboxAction,
  type LightboxState,
  lightboxKey,
  reduceLightbox,
  shouldDismiss,
  viewerFrame,
} from "../../lib/lightbox.ts";
import type { ChatImage } from "../../lib/transcript.ts";
import {
  concealSource,
  measureSource,
  naturalSizeOf,
  revealSource,
  sourceImage,
} from "../../lib/zoom-source.ts";
import { type LightboxRequest, useAppStore } from "../../state/app-store.ts";
import { cn, IconButton } from "../ui/controls.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconDownload,
} from "../ui/icons.tsx";

type Size = { width: number; height: number };

const OPEN: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.42,
  bounce: 0.16,
};
const CLOSE: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.34,
  bounce: 0.06,
};
/** Springing back after a drag, zooming in and out. */
const SETTLE: ValueAnimationTransition<number> = {
  type: "spring",
  visualDuration: 0.3,
  bounce: 0.2,
};
const FADE: ValueAnimationTransition<number> = { duration: 0.22, ease: [0.32, 0.72, 0, 1] };
/** Where the picture starts (and ends) with no thumbnail: slightly smaller, faded. */
const NO_SOURCE = { x: 0, y: 0, scale: 0.92 };
const CLOSE_TIMEOUT_MS = 900;

export function Lightbox() {
  const request = useAppStore((s) => s.lightbox);
  return (
    <AnimatePresence>
      {request && request.images.length > 0 && <Viewer key={keyOf(request)} request={request} />}
    </AnimatePresence>
  );
}

// A fresh viewer per request (a closing one may still be flying home while the next opens).
const keys = new WeakMap<LightboxRequest, number>();
let lastKey = 0;
function keyOf(request: LightboxRequest): number {
  let key = keys.get(request);
  if (key === undefined) {
    key = ++lastKey;
    keys.set(request, key);
  }
  return key;
}

/** The frame's box and corner radii as motion values. */
type FrameValues = MotionValue<number>[]; // x, y, width, height, tl, tr, br, bl

const frameList = (f: Frame) => [f.x, f.y, f.width, f.height, ...f.radius];
const frameValues = (f: Frame): FrameValues => frameList(f).map((n) => motionValue(n));
const frameOf = (v: FrameValues): Frame => {
  const [x = 0, y = 0, width = 0, height = 0, tl = 0, tr = 0, br = 0, bl = 0] = v.map((m) =>
    m.get(),
  );
  return { x, y, width, height, radius: [tl, tr, br, bl] };
};
function jumpFrame(v: FrameValues, f: Frame) {
  for (const [i, n] of frameList(f).entries()) v[i]?.jump(n);
}
function animateFrame(v: FrameValues, f: Frame, transition: ValueAnimationTransition<number>) {
  return Promise.all(
    frameList(f).map((n, i) => (v[i] ? animate(v[i], n, transition).finished : null)),
  );
}

function sizeOf(image: ChatImage | undefined, natural: Record<string, Size>): Size {
  if (!image) return { width: 1, height: 1 };
  return (
    natural[image.assetId] ??
    (image.width && image.height
      ? { width: image.width, height: image.height }
      : { width: 4, height: 5 })
  );
}

function useViewport(): Size {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function Viewer({ request }: { request: LightboxRequest }) {
  const { images, sourceOf } = request;
  const [isPresent, safeToRemove] = usePresence();
  const still = useReducedMotion() === true; // fades only
  const [state, setState] = useState<LightboxState>(() => ({
    index: Math.min(Math.max(request.index, 0), images.length - 1),
    count: images.length,
    zoomed: false,
  }));
  const [dragging, setDragging] = useState(false);
  const viewport = useViewport();
  const [natural, setNatural] = useState<Record<string, Size>>({});
  const image = images[state.index];
  const fit = fitRect(sizeOf(image, natural), viewport);
  const { x: fitX, y: fitY, width: fitWidth, height: fitHeight } = fit;
  const thumbnail = useCallback(
    (index: number) => sourceImage(sourceOf?.(index) ?? null),
    [sourceOf],
  );

  // The moving picture: its frame (from the thumbnail at first), opacity (fades without one),
  // the scrim, and the drag / zoom transform.
  const [v] = useState(() => {
    const from = still ? null : measureSource(thumbnail(state.index));
    return {
      frame: frameValues(from ?? bakeTransform(viewerFrame(fit), NO_SOURCE)),
      opacity: motionValue(from ? 1 : 0),
      scrim: motionValue(0),
      x: motionValue(0),
      y: motionValue(0),
      scale: motionValue(1),
    };
  });

  // The shown picture's thumbnail stays empty while the viewer has it.
  const hidden = useRef<HTMLElement | null>(null);
  const showThumbnail = useCallback(() => {
    revealSource(hidden.current);
    hidden.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!isPresent) return;
    const el = thumbnail(state.index);
    const id = images[state.index]?.assetId;
    const size = naturalSizeOf(el);
    if (id && size) setNatural((n) => (n[id] ? n : { ...n, [id]: size }));
    if (still || el === hidden.current) return;
    showThumbnail();
    concealSource(el);
    hidden.current = el;
  }, [isPresent, still, thumbnail, images, state.index, showThumbnail]);
  useEffect(() => showThumbnail, [showThumbnail]);

  // Open: fly to the fitted frame. Later: follow it (the picture's real size arrived, the window
  // resized) — or jump to it when paging.
  const shownIndex = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!isPresent) return;
    const to = viewerFrame({ x: fitX, y: fitY, width: fitWidth, height: fitHeight });
    if (shownIndex.current === null || shownIndex.current === state.index) {
      void animateFrame(v.frame, to, still ? FADE : OPEN);
    } else {
      jumpFrame(v.frame, to);
      v.x.jump(0);
      v.y.jump(0);
      v.scale.jump(1);
    }
    shownIndex.current = state.index;
  }, [isPresent, still, v, fitX, fitY, fitWidth, fitHeight, state.index]);

  useEffect(() => {
    animate(v.scrim, 1, { duration: 0.3, ease: "easeOut" });
    animate(v.opacity, 1, FADE);
  }, [v]);

  // Close: shrink back into the thumbnail from wherever the picture is (dragged, zoomed), or fade.
  const closing = useRef({ index: state.index, safeToRemove });
  closing.current = { index: state.index, safeToRemove };
  useEffect(() => {
    if (isPresent) return;
    const home = still ? null : measureSource(thumbnail(closing.current.index));
    const from = bakeTransform(frameOf(v.frame), {
      x: v.x.get(),
      y: v.y.get(),
      scale: v.scale.get(),
    });
    v.x.jump(0);
    v.y.jump(0);
    v.scale.jump(1);
    jumpFrame(v.frame, from);
    if (!home) showThumbnail();
    animate(v.scrim, 0, home ? CLOSE : FADE);
    const flight = home
      ? animateFrame(v.frame, home, CLOSE)
      : Promise.all([
          animateFrame(v.frame, bakeTransform(from, NO_SOURCE), FADE),
          animate(v.opacity, 0, FADE).finished,
        ]);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      showThumbnail();
      closing.current.safeToRemove?.();
    };
    const timeout = setTimeout(finish, CLOSE_TIMEOUT_MS);
    void flight.then(finish);
    return () => clearTimeout(timeout);
  }, [isPresent, still, thumbnail, v, showThumbnail]);

  const close = useCallback(() => {
    const store = useAppStore.getState();
    if (store.lightbox === request) store.closeLightbox();
  }, [request]);

  const dispatch = useCallback(
    (action: LightboxAction) => {
      const next = reduceLightbox(state, action);
      if (next === null) {
        close();
        return;
      }
      if (next.zoomed !== state.zoomed) {
        animate(v.scale, next.zoomed ? 2 : 1, SETTLE);
        if (!next.zoomed) {
          animate(v.x, 0, SETTLE);
          animate(v.y, 0, SETTLE);
        }
      }
      setState(next);
    },
    [state, close, v],
  );

  useEffect(() => {
    if (!isPresent) return;
    const onKey = (event: KeyboardEvent) => {
      const action = lightboxKey(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isPresent, dispatch]);

  // Drag: pans when zoomed, else drag to dismiss.
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(
    null,
  );
  const moved = useRef(false);
  const endDrag = (event: React.PointerEvent, released: boolean) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!moved.current || state.zoomed) return;
    setDragging(false);
    if (released && shouldDismiss(event.clientY - d.y, v.y.getVelocity())) {
      close();
      return;
    }
    animate(v.x, 0, SETTLE);
    animate(v.y, 0, SETTLE);
    animate(v.scale, 1, SETTLE);
    animate(v.scrim, 1, SETTLE);
  };

  if (!image) return null;
  const chrome = isPresent && !dragging;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Görsel"
      className={cn("fixed inset-0 z-[100]", !isPresent && "pointer-events-none")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <motion.div
        className="pointer-events-none absolute inset-0 bg-scrim"
        style={{ opacity: v.scrim }}
      />
      <motion.div
        data-testid="lightbox-frame"
        className={cn(
          "absolute touch-none overflow-hidden select-none",
          state.zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        )}
        style={{
          left: v.frame[0],
          top: v.frame[1],
          width: v.frame[2],
          height: v.frame[3],
          borderTopLeftRadius: v.frame[4],
          borderTopRightRadius: v.frame[5],
          borderBottomRightRadius: v.frame[6],
          borderBottomLeftRadius: v.frame[7],
          x: v.x,
          y: v.y,
          scale: v.scale,
          opacity: v.opacity,
          background: image.background,
        }}
        onDoubleClick={() => dispatch({ kind: "toggleZoom" })}
        onPointerDown={(event) => {
          if (event.button !== 0 || !isPresent) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            panX: v.x.get(),
            panY: v.y.get(),
          };
          moved.current = false;
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || d.id !== event.pointerId) return;
          const dx = event.clientX - d.x;
          const dy = event.clientY - d.y;
          if (!moved.current) {
            if (Math.hypot(dx, dy) < 4) return;
            moved.current = true;
            for (const m of [v.x, v.y, v.scale, v.scrim]) m.stop();
            if (!state.zoomed) setDragging(true);
          }
          if (state.zoomed) {
            v.x.set(d.panX + dx);
            v.y.set(d.panY + dy);
            return;
          }
          const follow = dismissDrag(dx, dy, viewport.height);
          v.x.set(follow.x);
          v.y.set(follow.y);
          v.scale.set(follow.scale);
          v.scrim.set(1 - follow.progress);
        }}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
      >
        <img
          key={image.assetId}
          src={imageUrl(image)}
          alt={image.caption ?? ""}
          draggable={false}
          onLoad={(event) => {
            const size = naturalSizeOf(event.currentTarget);
            if (size) setNatural((n) => (n[image.assetId] ? n : { ...n, [image.assetId]: size }));
          }}
          className="pointer-events-none size-full object-cover"
        />
      </motion.div>
      <motion.div
        className="absolute top-3.5 right-3.5"
        initial={{ opacity: 0 }}
        animate={{ opacity: chrome ? 1 : 0 }}
        transition={{ duration: 0.2 }}
      >
        <IconButton
          icon={<IconClose size={16} strokeWidth={1.75} />}
          label="Kapat"
          shortcut="Esc"
          className="text-white hover:bg-white/10"
          onClick={close}
        />
      </motion.div>
      <motion.div
        className="absolute inset-x-0 bottom-0 flex h-[60px] items-center px-6 text-footnote text-white/80"
        initial={{ opacity: 0 }}
        animate={{ opacity: chrome ? 1 : 0 }}
        transition={{ duration: 0.2 }}
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
      </motion.div>
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
