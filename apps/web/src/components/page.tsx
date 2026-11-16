import type { ReactNode } from "react";
import { Link } from "react-router";
import { hueFor, initials } from "../lib/format.ts";
import type { StatusMeta } from "../lib/labels.ts";
import { IconArrowLeft } from "./icons.tsx";
import { Badge, cx } from "./ui.tsx";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:mb-8 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {back && (
          <Link
            to={back.to}
            className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink"
          >
            <IconArrowLeft size={16} />
            {back.label}
          </Link>
        )}
        {eyebrow && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
            {eyebrow}
          </div>
        )}
        <h1 className="font-display text-[40px] leading-[1.02] tracking-[-0.01em] text-ink break-words sm:text-[52px]">
          {title}
        </h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function StatusBadge({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <Badge tone={meta.tone} title={meta.hint} {...(className ? { className } : {})}>
      {meta.label}
    </Badge>
  );
}

/** Coloured monogram for a brand (hue derived from its id). */
export function BrandMark({
  id,
  name,
  size = 32,
  className,
}: {
  id: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const hue = hueFor(id);
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-[30%] font-semibold",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `oklch(0.86 0.07 ${hue})`,
        color: `oklch(0.32 0.09 ${hue})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>;
}
