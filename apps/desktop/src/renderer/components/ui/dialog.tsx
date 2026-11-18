// Modal sheet (Wecra "Settings sheet" look): the window dims, a rounded popover-surface panel
// sits in the middle with a header (title + ✕), body and an optional footer of capsule buttons.
// Esc and a click on the backdrop close it; focus moves into the panel, stays there (Tab) and
// goes back on close (modal.ts). `ConfirmDialog` is the yes / no variant (delete, publish now).
import { type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, cn, IconButton } from "./controls.tsx";
import { IconClose } from "./icons.tsx";
import { useModal } from "./modal.ts";

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  width = 460,
  label,
  className,
  role = "dialog",
}: {
  open: boolean;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Accessible name when `title` is not plain text. */
  label?: string;
  className?: string;
  /** `alertdialog` for a question that interrupts (Ayarlar's confirmations). */
  role?: "dialog" | "alertdialog";
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  useModal(panel, { open, onClose });

  if (!open) return null;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes (Esc does too)
    <div
      className="fixed inset-0 z-[97] flex items-center justify-center bg-black/30 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: dialog and alertdialog both take aria-modal */}
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        className={cn(
          "flex max-h-[86vh] animate-pop-in flex-col rounded-[14px] bg-popover text-body text-fg shadow-popover outline-none",
          className,
        )}
        style={{ width }}
      >
        <div className="flex h-12 shrink-0 items-center border-b border-hairline pr-2 pl-5">
          <h2 className="min-w-0 flex-1 truncate text-heading font-semibold text-fg">{title}</h2>
          <IconButton
            icon={<IconClose size={16} />}
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
    </div>,
    document.body,
  );
}

/** The yes / no question (also Ayarlar's confirmations: features/settings/parts.tsx). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Vazgeç",
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
  role,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  role?: "dialog" | "alertdialog";
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      width={420}
      {...(role ? { role } : {})}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus=""
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="selectable text-body text-fg-2">{message}</div>
    </Dialog>
  );
}
