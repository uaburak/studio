// The opened post's stage: the shown version's slide (carousel paging below it), a reel's
// player, and — on the Düzenle tab — the layer editor on top of the render: click selects the
// layer under the pointer, dragging moves it, the corner handle resizes it. Edits go out
// through the editor (a `content.render` patch); the outline follows the edit while it renders.
import { readReelVersionInfo } from "@studio/contract";
import { useLayoutEffect, useRef, useState } from "react";
import { Button, cn, IconButton, Spinner } from "../../components/ui/controls.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconPlay,
} from "../../components/ui/icons.tsx";
import { assetUrl } from "../../lib/api.ts";
import { PostMedia } from "../posts/post-media.tsx";
import { type Box, boxOf, editableLayers, hitTest } from "../posts/slides.ts";
import {
  activeVersion,
  activityMessage,
  currentSlide,
  type EditorSnapshot,
  editBlocker,
  isViewingCurrent,
  type PostEditor,
  slideLayers,
  slidesOf,
} from "./editor.ts";

type Drag =
  | { kind: "move"; layer: string; startX: number; startY: number; dx: number; dy: number }
  | { kind: "resize"; layer: string; startX: number; box: Box; factor: number };

const HANDLE = 12;

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The largest artboard-shaped rect that fits (`maxWidth` caps it). */
export function fitStage(
  artboard: { width: number; height: number },
  bounds: { width: number; height: number },
  maxWidth = Number.POSITIVE_INFINITY,
): { width: number; height: number } {
  if (artboard.width <= 0 || artboard.height <= 0 || bounds.width <= 0 || bounds.height <= 0)
    return { width: 0, height: 0 };
  const scale = Math.min(
    Math.min(bounds.width, maxWidth) / artboard.width,
    bounds.height / artboard.height,
  );
  return { width: Math.floor(artboard.width * scale), height: Math.floor(artboard.height * scale) };
}

export function SlideStage({
  snapshot,
  editor,
  editing,
  brandName,
  onQuickLook,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
  editing: boolean;
  brandName?: string | undefined;
  onQuickLook(): void;
}) {
  const bounds = useRef<HTMLDivElement | null>(null);
  const size = useSize(bounds);
  const slides = slidesOf(snapshot);
  const slide = currentSlide(snapshot);
  const version = activeVersion(snapshot);
  const isReel = snapshot.content.type === "reel";
  const artboard = { width: slide?.width ?? 1080, height: slide?.height ?? 1350 };
  const stage = fitStage(artboard, size, 640);
  const scale = stage.width > 0 ? stage.width / artboard.width : 1;
  const activity = snapshot.activity;
  const viewingOld = !isViewingCurrent(snapshot);

  return (
    <div
      className="flex h-full min-h-0 shrink-0 flex-col items-center"
      style={{ width: "min(640px, 52%)" }}
    >
      <div ref={bounds} className="relative flex min-h-0 w-full flex-1 items-start justify-center">
        <div
          className="relative overflow-hidden rounded-[14px] bg-control shadow-md"
          style={{ width: stage.width, height: stage.height }}
          data-testid="slide-stage"
        >
          {isReel && slide ? (
            <ReelPlayer html={slide.html} key={version?.id} />
          ) : slide?.renderedAssetId ? (
            <img
              src={assetUrl(slide.renderedAssetId)}
              alt={`Slayt ${snapshot.slideIndex + 1}`}
              draggable={false}
              onDoubleClick={onQuickLook}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <PostMedia
              contentId={snapshot.content.id}
              title={snapshot.content.title}
              brandName={brandName}
              version={null}
              isReel={false}
              size="large"
              className="absolute inset-0"
            />
          )}
          {editing && !isReel && slide && (
            <LayerOverlay snapshot={snapshot} editor={editor} scale={scale} />
          )}
          {activity.kind !== "idle" && (
            <div className="glass absolute top-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full pr-1.5 pl-3 text-body text-fg">
              <Spinner size={13} />
              <span className="whitespace-nowrap">{activityMessage(activity)}</span>
              {(activity.kind === "revising" || activity.kind === "rendering") &&
              snapshot.revisionJobId ? (
                <IconButton
                  icon={<IconClose size={12} />}
                  label={
                    activity.kind === "revising" ? "AI düzenlemesini durdur" : "Videoyu durdur"
                  }
                  size={24}
                  onClick={() => void editor.cancelRevision()}
                />
              ) : (
                <span className="w-1.5" />
              )}
            </div>
          )}
          {viewingOld && version && (
            <div className="glass absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-full py-1 pr-1 pl-3.5 text-body">
              <span className="min-w-0 flex-1 truncate text-fg">
                v{version.version} görüntüleniyor
                <span className="text-fg-2">
                  {" "}
                  · güncel v{snapshot.content.currentVersion?.version}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void editor.showCurrent()}>
                Güncele dön
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={activity.kind !== "idle" || snapshot.content.status === "published"}
                onClick={() => void editor.restoreDisplayed()}
              >
                Bu sürümü geri yükle
              </Button>
            </div>
          )}
        </div>
      </div>
      {slides.length > 1 && (
        <fieldset
          className="m-0 border-0 p-0 mt-3 flex h-7 shrink-0 items-center gap-2"
          aria-label="Slaytlar"
        >
          <IconButton
            icon={<IconChevronLeft size={16} strokeWidth={1.5} />}
            label="Önceki slayt"
            shortcut="←"
            disabled={snapshot.slideIndex === 0}
            onClick={() => editor.selectSlide(snapshot.slideIndex - 1)}
          />
          <div className="flex items-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={`${i}-${s.renderedAssetId ?? ""}`}
                type="button"
                aria-label={`Slayt ${i + 1}`}
                aria-current={i === snapshot.slideIndex || undefined}
                onClick={() => editor.selectSlide(i)}
                className={cn(
                  "size-1.5 rounded-full transition-colors",
                  i === snapshot.slideIndex ? "bg-fg" : "bg-control-pressed hover:bg-fg-3",
                )}
              />
            ))}
          </div>
          <span className="min-w-[40px] text-center text-footnote text-fg-2 tabular-nums">
            {snapshot.slideIndex + 1} / {slides.length}
          </span>
          <IconButton
            icon={<IconChevronRight size={16} strokeWidth={1.5} />}
            label="Sonraki slayt"
            shortcut="→"
            disabled={snapshot.slideIndex >= slides.length - 1}
            onClick={() => editor.selectSlide(snapshot.slideIndex + 1)}
          />
        </fieldset>
      )}
    </div>
  );
}

function LayerOverlay({
  snapshot,
  editor,
  scale,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
  scale: number;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const slide = currentSlide(snapshot);
  const blocker = editBlocker(snapshot);
  const layers = editableLayers(slideLayers(snapshot));
  const editable = new Set(layers.map((l) => l.layerId));
  const boxes = (slide?.layers ?? []).filter((b) => editable.has(b.id));
  const selected = snapshot.selectedLayerId;

  const boxFor = (id: string): Box | null => {
    const preview = snapshot.previewBoxes[id];
    if (preview) return preview;
    const measured = boxes.find((b) => b.id === id);
    return measured ? boxOf(measured) : null;
  };

  const point = (event: React.PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const p = point(event);
    const selectedBox = selected ? boxFor(selected) : null;
    if (
      selected &&
      selectedBox &&
      !blocker &&
      Math.abs(p.x - (selectedBox.x + selectedBox.w)) * scale <= HANDLE &&
      Math.abs(p.y - (selectedBox.y + selectedBox.h)) * scale <= HANDLE
    ) {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      setDrag({
        kind: "resize",
        layer: selected,
        startX: event.clientX,
        box: selectedBox,
        factor: 1,
      });
      return;
    }
    const hit = hitTest(p.x, p.y, boxes);
    editor.selectLayer(hit?.id ?? null);
    if (hit && !blocker) {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      setDrag({
        kind: "move",
        layer: hit.id,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
      });
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) {
      const p = point(event);
      setHover(hitTest(p.x, p.y, boxes)?.id ?? null);
      return;
    }
    if (drag.kind === "move") {
      setDrag({
        ...drag,
        dx: (event.clientX - drag.startX) / scale,
        dy: (event.clientY - (drag.startY ?? 0)) / scale,
      });
    } else {
      const width = drag.box.w * scale;
      const factor = width > 0 ? Math.max(0.1, (width + (event.clientX - drag.startX)) / width) : 1;
      setDrag({ ...drag, factor });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    if (drag.kind === "move") {
      if (Math.abs(drag.dx) * scale >= 2 || Math.abs(drag.dy) * scale >= 2) {
        editor.move(drag.layer, Math.round(drag.dx), Math.round(drag.dy));
      }
    } else if (Math.abs(drag.factor - 1) > 0.01) {
      editor.resize(drag.layer, drag.factor);
    }
    setDrag(null);
  };

  const outline = (id: string): Box | null => {
    const box = boxFor(id);
    if (!box) return null;
    if (drag?.layer === id && drag.kind === "move")
      return { ...box, x: box.x + drag.dx, y: box.y + drag.dy };
    if (drag?.layer === id && drag.kind === "resize")
      return { ...box, w: box.w * drag.factor, h: box.h * drag.factor };
    return box;
  };

  const rect = (b: Box) => ({
    left: b.x * scale,
    top: b.y * scale,
    width: Math.max(2, b.w * scale),
    height: Math.max(2, b.h * scale),
  });

  const selectedBox = selected ? outline(selected) : null;
  const hoverBox = hover && hover !== selected ? outline(hover) : null;
  return (
    // Pointer layer editing; the inspector has the same edits with the keyboard.
    <div
      className="absolute inset-0 touch-none"
      style={{ cursor: drag ? (drag.kind === "move" ? "grabbing" : "nwse-resize") : "default" }}
      data-testid="layer-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      {boxes.length === 0 && (
        <span className="glass absolute top-3 left-3 rounded-full px-2.5 py-1 text-caption text-fg-2">
          Katman kutuları bir sonraki render ile gelir; listeden düzenleyebilirsin.
        </span>
      )}
      {hoverBox && (
        <span
          className="pointer-events-none absolute rounded-[2px] shadow-[0_0_0_1px_rgba(255,255,255,.7),0_0_0_2px_rgba(0,0,0,.25)]"
          style={rect(hoverBox)}
        />
      )}
      {selectedBox && (
        <span
          className="pointer-events-none absolute rounded-[2px] shadow-[0_0_0_2px_var(--accent-default)]"
          style={rect(selectedBox)}
          data-testid="selected-outline"
        >
          {!blocker && (
            <span
              className="absolute -right-[5px] -bottom-[5px] size-2.5 rounded-full border-2 border-white bg-accent"
              aria-hidden="true"
            />
          )}
        </span>
      )}
    </div>
  );
}

function ReelPlayer({ html }: { html: string }) {
  const info = readReelVersionInfo(html);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  if (!info.videoAssetId) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-body text-white/70">
        Video henüz hazır değil.
      </div>
    );
  }
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: rendered reels carry burned-in captions */}
      <video
        ref={video}
        src={assetUrl(info.videoAssetId)}
        poster={info.coverAssetId ? assetUrl(info.coverAssetId) : undefined}
        controls={playing}
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPlaying(true)}
        className="absolute inset-0 size-full bg-black object-cover"
        data-testid="reel-video"
      />
      {!playing && (
        <button
          type="button"
          aria-label="Reels'i oynat"
          onClick={() => {
            setPlaying(true);
            void video.current?.play().catch(() => undefined);
          }}
          className="absolute inset-0 flex items-center justify-center bg-black/10"
        >
          <span className="glass flex size-16 items-center justify-center rounded-full text-fg">
            <IconPlay size={26} fill="currentColor" strokeWidth={0} />
          </span>
        </button>
      )}
    </>
  );
}
