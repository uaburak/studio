// The layers, docked on the canvas's left edge as a floating glass list (the app's sidebar
// stays the app's): every slide is a top-level row (as Figma's frames) with its layers inside —
// select / shift-select, hover highlights on the canvas, hide, lock, drag to reorder within a
// container, double click a slide to focus it. It folds into a small "Katmanlar" pill.
//
// Why here and not in the right panel: the right panel switches between Düzenle and Sohbet,
// while the layers are needed in both (picking what to talk about is picking layers); the list
// keeps the Figma / Wecra arrangement (layers left of the canvas, properties right of it); and
// the properties keep the whole panel height instead of sharing it with a long tree.
import { useState } from "react";
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import { IconLayers, IconMinimize } from "../../../components/ui/icons.tsx";
import { assetUrl } from "../../../lib/api.ts";
import {
  type EditorLayer,
  layerLabel,
  layerTree,
  slideLabel,
  stackIndex,
  TYPE_LABEL,
} from "../model/document.ts";
import type { EditorSession } from "../session.ts";
import {
  IconChevronDown,
  IconChevronRight,
  IconDiamond,
  IconEye,
  IconEyeOff,
  IconGroup,
  IconImagePlus,
  IconLock,
  IconShape,
  IconText,
  IconUnlock,
} from "./glyphs.tsx";

export const LAYERS_DOCK_WIDTH = 248;

export function layerIcon(type: EditorLayer["type"], size = 13) {
  switch (type) {
    case "text":
      return <IconText size={size} strokeWidth={1.5} />;
    case "image":
    case "slot":
      return <IconImagePlus size={size} strokeWidth={1.5} />;
    case "logo":
      return <IconDiamond size={size} strokeWidth={1.5} />;
    case "group":
      return <IconGroup size={size} strokeWidth={1.5} />;
    default:
      return <IconShape size={size} strokeWidth={1.5} />;
  }
}

/** A text layer is named by its text (as Figma names text layers); others by role / id. */
export function layerTitle(layer: EditorLayer): string {
  if (layer.type === "text" && layer.text?.trim()) return layer.text.replace(/\s+/g, " ").trim();
  return layerLabel(layer);
}

export function LayersDock({
  session,
  open,
  onOpenChange,
  thumbs,
}: {
  session: EditorSession;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Each slide's rendered picture (the shown version), for the slide rows. */
  thumbs: readonly (string | null)[];
}) {
  const count = session.canvas.editorSlides.reduce((n, s) => n + s.layers.length, 0);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-expanded={false}
        className="glass pointer-events-auto absolute top-3 left-3 z-20 flex h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-body text-fg hover:text-fg"
      >
        <IconLayers size={14} strokeWidth={1.5} className="text-icon" />
        Katmanlar
        <span className="text-fg-3 tabular-nums">{count}</span>
      </button>
    );
  }
  return (
    <section
      aria-label="Katmanlar paneli"
      className="glass pointer-events-auto absolute top-3 left-3 z-20 flex flex-col overflow-hidden rounded-[18px]"
      // As tall as its rows, ending above the dock (its height is `--dock-h`).
      style={{ width: LAYERS_DOCK_WIDTH, maxHeight: "calc(100% - var(--dock-h, 48px) - 36px)" }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 pr-1.5 pl-3.5">
        <h2 className="min-w-0 flex-1 truncate text-footnote font-semibold text-fg">
          Katmanlar
          <span className="ml-1.5 font-normal text-fg-3 tabular-nums">{count}</span>
        </h2>
        <IconButton
          size={24}
          icon={<IconMinimize size={12} strokeWidth={1.5} />}
          label="Katmanları küçült"
          aria-expanded={true}
          onClick={() => onOpenChange(false)}
        />
      </div>
      <LayerTree session={session} thumbs={thumbs} />
    </section>
  );
}

function LayerTree({
  session,
  thumbs,
}: {
  session: EditorSession;
  thumbs: readonly (string | null)[];
}) {
  const { canvas, canvasState: s } = session;
  const slides = canvas.editorSlides;
  // Slides are folded except the active one (and any holding the selection), until opened by hand.
  const [toggled, setToggled] = useState<Map<number, boolean>>(() => new Map());
  const [drag, setDrag] = useState<string | null>(null);
  const selection = new Set(s.selection);
  const locked = new Set(s.locked);

  const toggleSlide = (i: number, open: boolean) =>
    setToggled((t) => {
      const next = new Map(t);
      next.set(i, !open);
      return next;
    });

  if (slides.length === 0)
    return <p className="px-3.5 pb-3 text-footnote text-fg-3">Henüz bir tasarım yok.</p>;

  return (
    <div
      className="scroll-area min-h-0 flex-1 px-1.5 pb-1.5"
      role="listbox"
      aria-label="Katmanlar"
      aria-multiselectable="true"
      data-editor-list=""
    >
      {slides.map((slide, i) => {
        const open =
          toggled.get(i) ?? (s.activeSlide === i || slide.layers.some((l) => selection.has(l.key)));
        const active = s.activeSlide === i;
        const thumb = thumbs[i] ?? null;
        return (
          <div key={`tree-${i}`}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: arrows on the canvas turn the slides */}
            <div
              role="option"
              tabIndex={-1}
              aria-selected={false}
              aria-label={`Kare ${i + 1} · ${slideLabel(slide)}`}
              onClick={() => canvas.selectSlide(i, { zoom: s.focus !== null })}
              onDoubleClick={() => {
                canvas.selectSlide(i);
                canvas.setFocus(i);
              }}
              className={cn(
                "group flex h-8 items-center gap-1.5 rounded-full pr-2 pl-1",
                active ? "text-fg" : "text-fg-2",
                "hover:bg-control",
              )}
            >
              <button
                type="button"
                aria-label={open ? "Kareyi kapat" : "Kareyi aç"}
                aria-expanded={open}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSlide(i, open);
                }}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-fg-3 hover:text-fg"
              >
                {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              </button>
              <span
                className={cn(
                  "relative h-[18px] w-[14px] shrink-0 overflow-hidden rounded-[4px] bg-control",
                  active && "ring-[1.5px] ring-accent",
                )}
              >
                {thumb && (
                  <img
                    src={assetUrl(thumb)}
                    alt=""
                    className="absolute inset-0 size-full object-cover"
                    draggable={false}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-body font-medium">
                {i + 1} · {slideLabel(slide)}
              </span>
              <span className="shrink-0 text-caption text-fg-3 tabular-nums">
                {slide.layers.length}
              </span>
            </div>
            {open &&
              layerTree(slide).map((layer) => {
                const isSelected = selection.has(layer.key);
                const isLocked = locked.has(layer.key);
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys are on the canvas
                  <div
                    key={layer.key}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    draggable
                    onDragStart={(e) => {
                      setDrag(layer.key);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => {
                      const from = drag ? canvas.layer(drag) : null;
                      if (
                        from &&
                        from.slide === layer.slide &&
                        from.parent === layer.parent &&
                        from.key !== layer.key
                      )
                        e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = drag ? canvas.layer(drag) : null;
                      setDrag(null);
                      if (!from || from.parent !== layer.parent) return;
                      const target = stackIndex(slide, layer.id).index;
                      canvas.applyOps(
                        [{ op: "moveLayer", layer: from.id, index: target, slide: from.slide }],
                        "Sırala",
                      );
                    }}
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey) {
                        const next = isSelected
                          ? s.selection.filter((k) => k !== layer.key)
                          : [...s.selection, layer.key];
                        canvas.selectLayers(next);
                      } else canvas.selectLayers([layer.key]);
                    }}
                    onPointerEnter={() => canvas.hoverLayer(layer.key)}
                    onPointerLeave={() => canvas.hoverLayer(null)}
                    className={cn(
                      "group flex h-7 items-center gap-1.5 rounded-full pr-1",
                      isSelected
                        ? "bg-accent-subtle"
                        : s.hover === layer.key
                          ? "bg-control"
                          : "hover:bg-control",
                      drag === layer.key && "opacity-50",
                    )}
                    style={{ paddingLeft: 24 + layer.depth * 14 }}
                    title={`${TYPE_LABEL[layer.type]} · ${layer.id}`}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center",
                        isSelected ? "text-accent-text" : "text-fg-3",
                      )}
                    >
                      {layerIcon(layer.type)}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-body",
                        layer.hidden ? "text-fg-3" : "text-fg",
                      )}
                    >
                      {layerTitle(layer)}
                    </span>
                    {(isSelected || isLocked) && (
                      <IconButton
                        size={24}
                        icon={isLocked ? <IconLock size={12} /> : <IconUnlock size={12} />}
                        label={isLocked ? "Kilidi aç" : "Kilitle"}
                        tooltip={false}
                        onClick={(e) => {
                          e.stopPropagation();
                          canvas.setLocked(layer.key, !isLocked);
                        }}
                      />
                    )}
                    <IconButton
                      size={24}
                      icon={layer.hidden ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                      label={layer.hidden ? "Göster" : "Gizle"}
                      tooltip={false}
                      className={cn(
                        !layer.hidden && !isSelected && "opacity-0 group-hover:opacity-100",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        canvas.applyOps(
                          [
                            {
                              op: "setVisibility",
                              layer: layer.id,
                              hidden: !layer.hidden,
                              slide: layer.slide,
                            },
                          ],
                          layer.hidden ? "Katmanı göster" : "Katmanı gizle",
                        );
                      }}
                    />
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
