// A sheet over the window (elevated surface, radius 14, like Claude's settings sheet): title, ✕,
// content, footer; Esc or a click on the dimmed backdrop closes it. Focus moves to its first
// field, stays inside (Tab) and goes back on close (modal.ts).
import { type ReactNode, useRef } from "react";
import { cn, IconButton } from "./controls.tsx";
import { IconClose } from "./icons.tsx";
import { useModal } from "./modal.ts";

export function Sheet({
  open,
  title,
  onClose,
  width = 520,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  useModal(panel, { open, onClose, initialFocus: "textarea, input, select, [data-autofocus]" });
  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes (Esc does too)
    <div
      className="fixed inset-0 z-[96] flex items-start justify-center bg-black/35 pt-[10vh] animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "flex max-h-[80vh] animate-pop-in flex-col overflow-hidden rounded-[14px] bg-popover shadow-[inset_0_0_0_1px_var(--glass-stroke),var(--shadow-popover)] outline-none",
          className,
        )}
        style={{ width }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline pr-2.5 pl-5">
          <h2 className="min-w-0 flex-1 truncate text-heading font-semibold text-fg">{title}</h2>
          <IconButton
            icon={<IconClose size={16} strokeWidth={1.5} />}
            label="Kapat"
            shortcut="Esc"
            onClick={onClose}
          />
        </div>
        <div className="scroll-area min-h-0 flex-1 px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
