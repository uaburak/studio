import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconClose } from "./icons.tsx";
import { Button, cx, IconButton } from "./ui.tsx";

/**
 * Modal built on the native <dialog> element: focus trapping, Escape and
 * inert background come from the browser. On phones it becomes a bottom sheet.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal() focuses the close button (first focusable); prefer the first field.
      el.querySelector<HTMLElement>(
        "[data-body] input:not([type=hidden]):not([type=radio]):not([type=checkbox]), [data-body] textarea, [data-body] select",
      )?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const widths = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-5xl" };

  return (
    // Escape is handled natively (cancel event); onClick only adds backdrop clicks.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is the native Escape key
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        "m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-3xl bg-surface p-0 text-ink shadow-card",
        "sm:m-auto sm:max-h-[86dvh] sm:rounded-3xl",
        widths[size],
        "open:animate-sheet open:flex open:flex-col",
      )}
    >
      {open && (
        <>
          <header className="flex items-start gap-3 px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="font-display text-[28px] leading-tight text-ink">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-sm text-ink-2">
                  {description}
                </p>
              )}
            </div>
            <IconButton label="Kapat" onClick={onClose} className="-mt-1 -mr-2">
              <IconClose />
            </IconButton>
          </header>
          <div data-body className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">
            {children}
          </div>
          {footer && (
            <footer className="pb-safe flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 py-4 sm:px-6">
              {footer}
            </footer>
          )}
        </>
      )}
    </dialog>
  );
}

/** Small confirm dialog for destructive or approval-revoking actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant={danger ? "accent" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[15px] leading-relaxed text-ink-2">{message}</div>
    </Dialog>
  );
}
