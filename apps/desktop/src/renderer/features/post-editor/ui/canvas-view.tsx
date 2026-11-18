// The canvas area: the slides' frames, the engine's canvas over them, and the editor's chrome
// on top (artboard titles, safe-area labels, collision chips, the selection's toolbar, the crop
// overlay, rulers), with the view toolbar above and the tools + AI prompt bar below.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn, IconButton, Spinner } from "../../../components/ui/controls.tsx";
import { IconWarning } from "../../../components/ui/icons.tsx";
import type { PostCanvas, CanvasView as View } from "../canvas/controller.ts";
import { layerLabel, slideLabel } from "../model/document.ts";
import { aabb, type OBox } from "../model/geometry.ts";
import type { EditorSession } from "../session.ts";
import { IconMagnet, IconPhoneFrame, IconRuler } from "./glyphs.tsx";

export function useCanvasView(canvas: PostCanvas): View {
  const ref = useRef<View>(canvas.getView());
  return useSyncExternalStore(
    (cb) =>
      canvas.onView((v) => {
        ref.current = v;
        cb();
      }),
    () => ref.current,
  );
}

function screenBox(view: View, rect: { x: number; y: number }, box: OBox) {
  const r = aabb(box);
  const z = view.camera.zoom;
  return {
    left: (rect.x + r.x) * z + view.camera.x,
    top: (rect.y + r.y) * z + view.camera.y,
    width: r.w * z,
    height: r.h * z,
  };
}

export function CanvasArea({
  session,
  bottom,
  selectionToolbar,
}: {
  session: EditorSession;
  bottom: React.ReactNode;
  selectionToolbar: React.ReactNode;
}) {
  const { canvas, canvasState } = session;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const c = canvasRef.current;
    const f = framesRef.current;
    if (!c || !f) return;
    void canvas.mount(c, f);
    return () => canvas.dispose();
  }, [canvas]);

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-page" data-testid="post-canvas">
      <div ref={framesRef} className="absolute inset-0 overflow-hidden" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        aria-label="Tuval"
        className={cn(
          "absolute inset-0 block size-full",
          canvasState.engine !== "ready" && "pointer-events-none",
        )}
      />
      <Chrome session={session} selectionToolbar={selectionToolbar} />
      <ViewToolbar session={session} />
      {canvasState.engine === "loading" && (
        <div className="glass pointer-events-none absolute top-16 left-1/2 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full px-3 text-footnote text-fg-2">
          <Spinner size={12} /> Tuval hazırlanıyor
        </div>
      )}
      {canvasState.engine === "unavailable" && (
        <div
          role="status"
          className="glass absolute top-16 left-1/2 flex max-w-[460px] -translate-x-1/2 items-start gap-2 rounded-[12px] px-3 py-2 text-footnote text-fg-2"
          title={canvasState.engineError ?? undefined}
        >
          <IconWarning size={13} className="mt-0.5 shrink-0 text-warning" />
          <span>
            Tasarım motoru başlatılamadı (WebGL2). Kareler gösteriliyor; katmanları soldaki listeden
            seçip sağdan düzenleyebilirsin.
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
        <div className="pointer-events-auto flex max-w-full items-end gap-2">{bottom}</div>
      </div>
    </div>
  );
}

function ViewToolbar({ session }: { session: EditorSession }) {
  const { canvas, canvasState: s } = session;
  const focus = s.focus !== null;
  return (
    <div className="glass absolute top-3 left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-0.5 rounded-full p-1">
      <div role="radiogroup" aria-label="Görünüm" className="flex rounded-full bg-control p-0.5">
        {[
          { value: false, label: "Tümü" },
          { value: true, label: "Odak" },
        ].map((o) => (
          // biome-ignore lint/a11y/useSemanticElements: a two-way segmented switch, as SegmentedControl
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={focus === o.value}
            onClick={() => canvas.setFocus(o.value ? s.activeSlide : null)}
            className={cn(
              "h-6 rounded-full px-2.5 text-footnote font-medium",
              focus === o.value ? "bg-surface-1 text-fg shadow-sm" : "text-fg-2 hover:text-fg",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="mx-1 h-4 w-px bg-hairline" />
      <IconButton
        size={28}
        icon={<IconPhoneFrame size={15} />}
        label="Güvenli alan"
        shortcut="⌘'"
        selected={s.safeArea}
        onClick={() => canvas.setSafeArea(!s.safeArea)}
      />
      <IconButton
        size={28}
        icon={<IconMagnet size={15} />}
        label="Yapışma"
        shortcut="⌘;"
        selected={s.snapping}
        onClick={() => canvas.setSnapping(!s.snapping)}
      />
      <IconButton
        size={28}
        icon={<IconRuler size={15} />}
        label="Cetveller"
        shortcut="⇧R"
        selected={s.rulers}
        onClick={() => canvas.setRulers(!s.rulers)}
      />
    </div>
  );
}

function Chrome({
  session,
  selectionToolbar,
}: {
  session: EditorSession;
  selectionToolbar: React.ReactNode;
}) {
  const { canvas, canvasState: s } = session;
  const view = useCanvasView(canvas);
  const slides = canvas.editorSlides;
  const rects = canvas.slideRects;
  const z = view.camera.zoom;
  const selected = s.selection.length === 1 ? s.selection[0] : null;
  const selectedBoxes = s.selection
    .map((key) => {
      const m = canvas.measureOf(key);
      const slide = Number(key.split(":")[0]);
      const rect = rects[slide];
      return m && rect ? screenBox(view, rect, m.box) : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const union = selectedBoxes.length
    ? selectedBoxes.reduce((a, b) => {
        const left = Math.min(a.left, b.left);
        const top = Math.min(a.top, b.top);
        return {
          left,
          top,
          width: Math.max(a.left + a.width, b.left + b.width) - left,
          height: Math.max(a.top + a.height, b.top + b.height) - top,
        };
      })
    : null;
  const collisions = useMemo(
    () => (s.safeArea ? slides.map((_, i) => canvas.collisionsOf(i)) : []),
    [s.safeArea, s.layoutRevision, slides, session.preset],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={false}>
      {s.rulers && <Rulers view={view} rect={rects[s.activeSlide] ?? null} />}
      {slides.map((slide, i) => {
        const rect = rects[i];
        if (!rect || (s.focus !== null && s.focus !== i)) return null;
        const left = rect.x * z + view.camera.x;
        const top = rect.y * z + view.camera.y;
        const width = rect.w * z;
        const active = s.activeSlide === i;
        const safe = s.safeArea ? session.safeArea(i) : null;
        return (
          <div key={`slide-${i}`}>
            <button
              type="button"
              onClick={() => canvas.selectSlide(i)}
              className="pointer-events-auto absolute flex h-5 items-end justify-between gap-2 text-[11px] leading-4"
              style={{ left, top: top - 22, width: Math.max(width, 60) }}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  active ? "font-medium text-accent-text" : "text-fg-2",
                )}
              >
                {i + 1} · {slideLabel(slide)}
              </span>
              {width > 150 && (
                <span className="shrink-0 text-fg-3 tabular-nums">
                  {slide.width} × {slide.height}
                </span>
              )}
            </button>
            {safe &&
              z > 0.18 &&
              safe.bands.map((band) => {
                const pos =
                  band.edge === "top"
                    ? { left: left + 8, top: top + 8 }
                    : band.edge === "bottom"
                      ? { left: left + 8, top: top + (rect.h - 8) * z - 22 }
                      : { left: left + (rect.w - 8) * z - 140, top: top + 8 };
                return (
                  <span
                    key={band.edge}
                    className="absolute flex h-[18px] items-center rounded-full bg-danger/85 px-2 text-[10.5px] font-medium whitespace-nowrap text-white"
                    style={pos}
                  >
                    {band.label}
                  </span>
                );
              })}
            {(s.dragging ? [] : (collisions[i] ?? [])).map((c) => {
              const m = canvas.measureOf(c.key);
              if (!m) return null;
              const b = screenBox(view, rect, m.box);
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => canvas.selectLayers([c.key])}
                  className="pointer-events-auto absolute flex h-[22px] -translate-x-1/2 items-center gap-1 rounded-full bg-danger px-2 text-[11px] font-medium whitespace-nowrap text-white shadow-sm"
                  style={{ left: b.left + b.width / 2, top: Math.max(4, b.top - 28) }}
                  title={c.message}
                >
                  <IconWarning size={11} strokeWidth={2} />
                  {c.edges.includes("bottom") && safe?.bands.some((x) => x.edge === "bottom")
                    ? "Yanıt alanıyla çakışıyor"
                    : "Güvenli alanın dışında"}
                </button>
              );
            })}
          </div>
        );
      })}
      {s.cropping && <CropOverlay session={session} view={view} />}
      {union && !s.editing && !s.cropping && !s.dragging && selectedBoxes.length > 0 && (
        <div
          className="pointer-events-auto absolute z-10 -translate-x-1/2"
          style={{
            left: Math.min(Math.max(union.left + union.width / 2, 180), view.width - 180),
            // Above the selection (with room for a warning chip), else under it.
            top: union.top - 84 > 56 ? union.top - 84 : union.top + union.height + 34,
          }}
        >
          {selectionToolbar}
        </div>
      )}
      {s.editing && selected && (
        <div
          className="glass absolute flex h-7 -translate-x-1/2 items-center rounded-full px-3 text-footnote text-fg-2"
          style={{
            left: (union?.left ?? 0) + (union?.width ?? 0) / 2,
            top: Math.max(8, (union?.top ?? 0) - 40),
          }}
        >
          Metni düzenliyorsun · ⌘↩ uygula · Esc vazgeç
        </div>
      )}
    </div>
  );
}

/** Rulers along the top and left edges, in the active slide's px. */
function Rulers({
  view,
  rect,
}: {
  view: View;
  rect: { x: number; y: number; w: number; h: number } | null;
}) {
  const z = view.camera.zoom;
  const ox = (rect?.x ?? 0) * z + view.camera.x;
  const oy = (rect?.y ?? 0) * z + view.camera.y;
  const steps = [10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => s * z >= 60) ?? 1000;
  const ticks = (length: number, origin: number) => {
    const out: number[] = [];
    const first = Math.ceil(-origin / z / step) * step;
    for (let v = first; v * z + origin < length; v += step) out.push(v);
    return out;
  };
  return (
    <>
      <div className="absolute inset-x-0 top-0 h-5 border-b border-hairline bg-surface-1/90 text-[9.5px] text-fg-3">
        {ticks(view.width, ox).map((v) => (
          <span
            key={v}
            className="absolute top-0 h-full border-l border-hairline pl-0.5 tabular-nums"
            style={{ left: v * z + ox }}
          >
            {v}
          </span>
        ))}
      </div>
      <div className="absolute inset-y-0 left-0 w-5 border-r border-hairline bg-surface-1/90 text-[9.5px] text-fg-3">
        {ticks(view.height, oy).map((v) => (
          <span
            key={v}
            className="absolute left-0 w-full border-t border-hairline tabular-nums [writing-mode:vertical-rl] rotate-180"
            style={{ top: v * z + oy }}
          >
            {v}
          </span>
        ))}
      </div>
    </>
  );
}

/** Crop: drag the picture inside its box (its focal point); Esc / a click outside ends it. */
function CropOverlay({ session, view }: { session: EditorSession; view: View }) {
  const { canvas, canvasState: s } = session;
  const key = s.cropping as string;
  const layer = canvas.layer(key);
  const m = canvas.measureOf(key);
  const rect = canvas.slideRects[Number(key.split(":")[0])];
  const start = useMemo(() => {
    const pos = (layer?.style["object-position"] ?? "50% 50%").split(/\s+/);
    const pct = (v: string | undefined) => (v?.endsWith("%") ? Number.parseFloat(v) : 50);
    return { x: pct(pos[0]), y: pct(pos[1]) };
  }, [layer]);
  const [pos, setPos] = useState(start);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  if (!layer || !m || !rect) return null;
  const b = screenBox(view, rect, m.box);
  const natural = canvas.imageSize(key);
  // How far the picture overflows its box under "cover" (screen px): the range of the focal point.
  const scale = natural ? Math.max(b.width / natural.w, b.height / natural.h) : 1;
  const overX = natural ? natural.w * scale - b.width : 0;
  const overY = natural ? natural.h * scale - b.height : 0;
  return (
    <div
      className="pointer-events-auto absolute cursor-move"
      style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, from: pos };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const nx =
          overX > 0
            ? Math.min(100, Math.max(0, d.from.x - ((e.clientX - d.x) / overX) * 100))
            : d.from.x;
        const ny =
          overY > 0
            ? Math.min(100, Math.max(0, d.from.y - ((e.clientY - d.y) / overY) * 100))
            : d.from.y;
        setPos({ x: nx, y: ny });
        canvas.previewCrop(key, { x: nx, y: ny });
      }}
      onPointerUp={() => {
        if (drag.current) canvas.commitCrop(key, pos);
        drag.current = null;
      }}
    >
      <div className="absolute inset-0 border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]" />
      {[1, 2].map((n) => (
        <div
          key={`v${n}`}
          className="absolute inset-y-0 w-px bg-white/60"
          style={{ left: `${(n * 100) / 3}%` }}
        />
      ))}
      {[1, 2].map((n) => (
        <div
          key={`h${n}`}
          className="absolute inset-x-0 h-px bg-white/60"
          style={{ top: `${(n * 100) / 3}%` }}
        />
      ))}
      <span className="glass absolute -bottom-8 left-1/2 flex h-6 -translate-x-1/2 items-center rounded-full px-2 text-[11px] whitespace-nowrap text-fg">
        Kırp · sürükle · Esc bitir · {Math.round(pos.x)}% {Math.round(pos.y)}%
      </span>
      <span className="sr-only">{layerLabel(layer)}</span>
    </div>
  );
}
