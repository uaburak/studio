import type { ReactNode } from "react";
import { describeError } from "../lib/errors.ts";
import { IconAlert } from "./icons.tsx";
import { Button, cx } from "./ui.tsx";

/** Empty state with a small drawn composition instead of a stock illustration. */
export function EmptyState({
  title,
  children,
  action,
  glyph,
  compact,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  glyph?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
      )}
    >
      {!compact && (
        <div className="relative mb-2 h-16 w-20" aria-hidden="true">
          <div className="absolute top-2 left-0 h-14 w-11 -rotate-6 rounded-lg bg-surface-3" />
          <div className="absolute top-0 left-5 flex h-14 w-11 rotate-3 items-center justify-center rounded-lg bg-surface shadow-card ring-1 ring-line text-accent">
            {glyph ?? <span className="font-display text-3xl leading-none">S</span>}
          </div>
        </div>
      )}
      <h3 className={cx("text-ink", compact ? "text-sm font-medium" : "font-display text-2xl")}>
        {title}
      </h3>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const view = describeError(error);
  return (
    <div
      role="alert"
      className={cx("flex items-start gap-3 rounded-2xl tint-bad", compact ? "p-3 text-sm" : "p-5")}
    >
      <IconAlert className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{view.title}</p>
        {view.detail && <p className="mt-1 text-sm break-words opacity-80">{view.detail}</p>}
        {view.issues && (
          <ul className="mt-2 list-disc pl-5 text-sm opacity-80">
            {view.issues.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <code className="font-mono text-xs">{i.path || "gövde"}</code>: {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Tekrar dene
        </Button>
      )}
    </div>
  );
}

/** Inline alert for mutation errors next to the control that caused them. */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return <ErrorState error={error} compact />;
}

export function Notice({
  tone = "info",
  children,
  icon,
}: {
  tone?: "info" | "warn" | "good" | "neutral";
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className={cx(
        `tint-${tone}`,
        "flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px] leading-snug",
      )}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 text-ink-2 [&_strong]:text-ink">{children}</div>
    </div>
  );
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div
      className={cx("flex flex-col gap-2", className)}
      role="status"
      aria-busy="true"
      aria-label="Yükleniyor"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-16 rounded-2xl" />
      ))}
    </div>
  );
}

export function SkeletonGrid({
  count = 8,
  aspect = "aspect-[4/5]",
}: {
  count?: number;
  aspect?: string;
}) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      role="status"
      aria-busy="true"
      aria-label="Yükleniyor"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cx("skeleton rounded-2xl", aspect)} />
      ))}
    </div>
  );
}
