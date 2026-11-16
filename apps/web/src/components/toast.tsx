import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { describeError } from "../lib/errors.ts";
import { IconAlert, IconCheck, IconClose } from "./icons.tsx";
import { cx } from "./ui.tsx";

interface Toast {
  id: number;
  kind: "success" | "error";
  title: string;
  detail?: string | undefined;
}

interface ToastApi {
  success: (title: string, detail?: string) => void;
  error: (error: unknown, fallbackTitle?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.kind === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, detail) => push({ kind: "success", title, detail }),
      error: (error, fallbackTitle) => {
        const view = describeError(error);
        push({ kind: "error", title: fallbackTitle ?? view.title, detail: view.detail });
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label="Bildirimler"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:right-6 lg:bottom-6 lg:left-auto lg:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={cx(
              "animate-sheet pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-bg shadow-card",
            )}
          >
            <span className={cx("mt-0.5", t.kind === "error" ? "text-accent" : "text-good")}>
              {t.kind === "error" ? <IconAlert size={18} /> : <IconCheck size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              {t.detail && <p className="mt-0.5 text-xs break-words opacity-70">{t.detail}</p>}
            </div>
            <button
              type="button"
              aria-label="Bildirimi kapat"
              onClick={() => dismiss(t.id)}
              className="-mr-1 rounded-lg p-1 opacity-60 hover:opacity-100"
            >
              <IconClose size={16} />
            </button>
          </div>
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
