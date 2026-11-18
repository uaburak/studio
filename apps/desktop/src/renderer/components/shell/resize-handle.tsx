// The invisible handle on a side panel's inner edge (Claude Code's): drag to resize, double-click
// to reset, ←/→ when focused. The owner clamps the width and keeps it (desktop settings).
import { type CSSProperties, useRef } from "react";
import { cn } from "../ui/controls.tsx";

export function ResizeHandle({
  edge,
  width,
  min,
  max,
  label,
  onResize,
  onReset,
  className,
  style,
}: {
  /** Which edge of its panel the handle sits on: the sidebar's right, the panel's left. */
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  label: string;
  onResize(width: number): void;
  onReset(): void;
  className?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width };
    const root = document.documentElement;
    root.dataset.resizing = "";
    const move = (e: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      const delta = e.clientX - start.x;
      onResize(edge === "right" ? start.width + delta : start.width - delta);
    };
    const up = () => {
      drag.current = null;
      delete root.dataset.resizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter (<hr> cannot be dragged or focused)
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (çift tıkla: varsayılan)`}
      data-edge={edge}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
        if (event.key === grow) onResize(width + step);
        else if (event.key === shrink) onResize(width - step);
        else return;
        event.preventDefault();
      }}
      className={cn(
        "no-drag absolute top-0 bottom-0 z-40 w-2 cursor-col-resize touch-none",
        edge === "right" ? "-right-1" : "-left-1",
        className,
      )}
      style={style}
    />
  );
}
