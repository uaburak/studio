// Glass popover anchored to an element (usage card, pickers). Esc and outside clicks close it.
import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  useFloating,
} from "@floating-ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { useAppStore } from "../../state/app-store.ts";
import { cn, IconButton } from "./controls.tsx";
import { IconClose } from "./icons.tsx";

export function Popover({
  anchor,
  open,
  onClose,
  placement = "top-end",
  className,
  label,
  children,
}: {
  anchor: Element | null;
  open: boolean;
  onClose(): void;
  placement?: Placement;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const {
    refs,
    floatingStyles,
    placement: final,
  } = useFloating({
    open,
    placement,
    elements: { reference: anchor },
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    // left/top, not transform: the pop-in animation's transform would override the position.
    transform: false,
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor, onClose]);
  if (!open) return null;
  return (
    <FloatingPortal>
      <div
        ref={(el) => {
          panel.current = el;
          refs.setFloating(el);
        }}
        role="dialog"
        aria-label={label}
        style={{
          ...floatingStyles,
          ["--pop-from" as string]: final.startsWith("top") ? "6px" : "-6px",
        }}
        className={cn(
          "glass z-[98] animate-pop-in rounded-[14px] p-3.5 text-body text-fg",
          className,
        )}
      >
        {children}
      </div>
    </FloatingPortal>
  );
}

/** Bordered card (plan cards, job cards): hairline, radius 12, surface fill. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-[12px] border border-border bg-transparent", className)}>
      {children}
    </div>
  );
}

/** Toasts: a dark capsule above the composer, orange glyph, optional action. */
export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-[95] flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="glass pointer-events-auto flex h-9 animate-pop-in items-center gap-2 rounded-full pr-1.5 pl-3 text-body"
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              toast.tone === "danger" ? "bg-danger" : "bg-accent",
            )}
          />
          <span className="max-w-[520px] truncate text-fg">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="ml-1 rounded-full px-2 py-1 font-medium text-accent-text hover:bg-control"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <IconButton
            icon={<IconClose size={12} />}
            label="Kapat"
            size={24}
            tooltip={false}
            onClick={() => dismiss(toast.id)}
          />
        </div>
      ))}
    </div>
  );
}
