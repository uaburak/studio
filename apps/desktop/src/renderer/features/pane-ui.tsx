// Small building blocks shared by the wave-2B panes and pages (Takvim, Medya, Marka, iPhone).
import type { ReactNode } from "react";
import { cn } from "../components/ui/controls.tsx";

/** A pane's empty / unavailable state: icon, one line, an optional action. */
export function PaneMessage({
  icon,
  text,
  detail,
  action,
}: {
  icon?: ReactNode;
  text: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 pt-2 text-body text-fg-2">
      {icon && <span className="text-icon">{icon}</span>}
      <p>{text}</p>
      {detail && <p className="text-footnote text-fg-3">{detail}</p>}
      {action}
    </div>
  );
}

/** Accent text link ("Takvimi aç →", "Tümü"). */
export function TextLink({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick(): void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "no-drag inline-flex items-center gap-1 rounded-full text-body font-medium text-accent-text hover:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Top of a full page: title (+ subtitle) on the left, actions on the right; `eyebrow` above
 *  the title (a link back to the list). */
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="shrink-0 px-8 pt-6 pb-4">
      {eyebrow}
      <div className="flex min-h-8 items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-fg">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-body text-fg-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Small grey section label inside cards ("Renkler", "Yazı tipleri"). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="text-footnote text-fg-3">{children}</div>;
}
