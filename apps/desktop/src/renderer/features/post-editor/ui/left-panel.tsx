// Left panel: the format the post is previewed as (platform × surface, its safe area), the
// slides, and the layers of every slide (hide, lock, reorder by dragging within a group).
import type { Content, ContentVersion } from "@studio/contract";
import { useState } from "react";
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import { IconEllipsis, PlatformIcon } from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import { assetUrl } from "../../../lib/api.ts";
import {
  type EditorLayer,
  type EditorSlide,
  layerLabel,
  layerTree,
  slideLabel,
  stackIndex,
  TYPE_LABEL,
} from "../model/document.ts";
import { presetFor, presetsForSlide } from "../model/safe-areas.ts";
import type { EditorSession } from "../session.ts";
import {
  IconChevronDown,
  IconChevronRight,
  IconDiamond,
  IconEye,
  IconEyeOff,
  IconFrame,
  IconGroup,
  IconImagePlus,
  IconLock,
  IconShape,
  IconText,
  IconUnlock,
} from "./glyphs.tsx";

const SURFACE_LABEL = {
  feed: "Akış",
  story: "Hikâye",
  "reel-cover": "Reels kapağı",
  document: "Belge",
} as const;

const TYPE_TITLE: Record<Content["type"], string> = {
  post: "Tekil",
  carousel: "Kaydırmalı",
  story: "Hikâye",
  reel: "Reels",
};

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

export function LeftPanel({
  session,
  content,
  version,
  brandName,
}: {
  session: EditorSession;
  content: Content;
  version: ContentVersion | null;
  brandName: string | null;
}) {
  const { canvas, canvasState: s } = session;
  const slides = canvas.editorSlides;
  const first = slides[0];
  const preset = first
    ? presetFor(content.type, content.targetPlatforms, first, session.preset)
    : null;
  const presets = first ? presetsForSlide(first) : [];
  const formatEntries: MenuEntry[] = presets.map((p) => ({
    id: p.id,
    label: p.label,
    checked: p.id === preset?.id,
    onSelect: () => session.setPreset(p.id),
  }));

  return (
    <aside
      className="flex w-[240px] shrink-0 flex-col border-r border-hairline bg-sidebar"
      aria-label="Kareler ve katmanlar"
    >
      <div className="border-b border-hairline p-2">
        <MenuButton
          entries={formatEntries}
          label="Önizleme biçimi"
          placement="bottom-start"
          width={230}
        >
          {({ ref, onClick, onKeyDown, open, ...aria }) => (
            <button
              ref={ref}
              type="button"
              onClick={onClick}
              onKeyDown={onKeyDown}
              {...aria}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-[10px] bg-control px-2.5 text-body text-fg hover:bg-control-hover",
                open && "bg-control-hover",
              )}
            >
              <PlatformIcon platform={preset?.platform ?? "instagram"} size={14} />
              <span className="min-w-0 flex-1 truncate text-left">
                {preset
                  ? `${preset.platform === "instagram" ? "Instagram" : preset.platform === "facebook" ? "Facebook" : "LinkedIn"} · ${content.type === "carousel" ? TYPE_TITLE.carousel : SURFACE_LABEL[preset.surface]} · ${preset.ratio}`
                  : `${TYPE_TITLE[content.type]} · ${first?.width ?? 0} × ${first?.height ?? 0}`}
              </span>
              <IconChevronDown size={13} className="text-fg-3" />
            </button>
          )}
        </MenuButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center px-4 text-footnote font-medium text-fg-2">
          Kareler · {slides.length}
        </div>
        <div
          className="scroll-area max-h-[40%] shrink-0 px-2 pb-2"
          role="listbox"
          aria-label="Kareler"
          data-editor-list=""
        >
          {slides.map((slide, i) => (
            <SlideRow
              key={`slide-${i}`}
              slide={slide}
              active={s.activeSlide === i}
              thumb={version?.slides[i]?.renderedAssetId ?? null}
              onSelect={() => canvas.selectSlide(i, { zoom: s.focus !== null })}
              onFocus={() => {
                canvas.selectSlide(i);
                canvas.setFocus(i);
              }}
            />
          ))}
        </div>
        <div className="flex h-9 shrink-0 items-center border-t border-hairline px-4 text-footnote font-medium text-fg-2">
          Katmanlar
        </div>
        <LayerTree session={session} />
      </div>

      <div className="border-t border-hairline p-2">
        <div className="flex h-8 items-center gap-2 rounded-[10px] bg-control px-2.5 text-body text-fg-2">
          <IconFrame size={13} strokeWidth={1.5} />
          <span className="min-w-0 flex-1 truncate">
            {brandName ?? "Marka"} ·{" "}
            {session.canvasState.engine === "ready" ? "marka seti" : "marka"}
          </span>
        </div>
      </div>
    </aside>
  );
}

function SlideRow({
  slide,
  active,
  thumb,
  onSelect,
  onFocus,
}: {
  slide: EditorSlide;
  active: boolean;
  thumb: string | null;
  onSelect(): void;
  onFocus(): void;
}) {
  const ratio = slide.height / slide.width;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: arrows on the canvas turn the slides
    <div
      role="option"
      tabIndex={-1}
      aria-selected={active}
      onClick={onSelect}
      onDoubleClick={onFocus}
      className={cn(
        "group flex h-14 items-center gap-2.5 rounded-[10px] px-2",
        active ? "bg-selected" : "hover:bg-control",
      )}
    >
      <span className="w-3 text-right text-caption text-fg-3 tabular-nums">{slide.index + 1}</span>
      <span
        className={cn(
          "relative w-8 shrink-0 overflow-hidden rounded-[5px] bg-control",
          active && "ring-2 ring-accent",
        )}
        style={{ height: Math.min(44, 32 * ratio) }}
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
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-fg">{slideLabel(slide)}</span>
        <span className="block text-caption text-fg-3">{slide.layers.length} katman</span>
      </span>
      <MenuButton
        entries={[
          { id: "focus", label: "Odakla", onSelect: onFocus },
          { id: "select", label: "Kareye git", onSelect: onSelect },
        ]}
        label="Kare işlemleri"
        placement="bottom-end"
        width={180}
      >
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <IconButton
            ref={ref}
            size={24}
            icon={<IconEllipsis size={14} />}
            label="Kare işlemleri"
            tooltip={false}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            onKeyDown={onKeyDown}
            selected={open}
            className={cn(!open && "opacity-0 group-hover:opacity-100")}
            {...aria}
          />
        )}
      </MenuButton>
    </div>
  );
}

function LayerTree({ session }: { session: EditorSession }) {
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

  return (
    <div
      className="scroll-area min-h-0 flex-1 px-2 pb-2"
      role="listbox"
      aria-label="Katmanlar"
      aria-multiselectable="true"
      data-editor-list=""
    >
      {slides.map((slide, i) => {
        const open =
          toggled.get(i) ?? (s.activeSlide === i || slide.layers.some((l) => selection.has(l.key)));
        return (
          <div key={`tree-${i}`}>
            <button
              type="button"
              onClick={() => toggleSlide(i, open)}
              onDoubleClick={() => canvas.selectSlide(i, { zoom: true })}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-body",
                s.activeSlide === i ? "text-fg" : "text-fg-2",
                "hover:bg-control",
              )}
            >
              {open ? (
                <IconChevronDown size={12} className="text-fg-3" />
              ) : (
                <IconChevronRight size={12} className="text-fg-3" />
              )}
              <IconFrame size={13} strokeWidth={1.5} className="text-fg-3" />
              <span className="min-w-0 truncate">
                Kare {i + 1} · {slideLabel(slide)}
              </span>
            </button>
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
                      "group flex h-7 items-center gap-1.5 rounded-[8px] pr-1",
                      isSelected
                        ? "bg-accent-subtle"
                        : s.hover === layer.key
                          ? "bg-control"
                          : "hover:bg-control",
                      drag === layer.key && "opacity-50",
                    )}
                    style={{ paddingLeft: 26 + layer.depth * 14 }}
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

/** A text layer is named by its text (as Figma names text layers); others by role / id. */
export function layerTitle(layer: EditorLayer): string {
  if (layer.type === "text" && layer.text?.trim()) return layer.text.replace(/\s+/g, " ").trim();
  return layerLabel(layer);
}
