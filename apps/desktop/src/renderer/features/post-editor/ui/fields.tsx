// The edit panel's building blocks, laid out as Wecra's properties panel (its PanelSection and
// PropertyGrid: a 40 px section header with the title 16 in and the actions 8 from the right,
// rows of two field columns and a 24 px action column, a line under each section) with Studio's
// capsule controls: number fields that commit on ↩ / blur (↑ ↓ step, ⇧ ×10), a colour field,
// a select, a slider, button groups and chips.
import { Children, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../../components/ui/controls.tsx";
import { IconChevronDown } from "./glyphs.tsx";

export function Section({
  title,
  action,
  children,
  empty,
  className,
}: {
  title: string;
  /** Icon buttons at the header's right. */
  action?: ReactNode;
  children?: ReactNode;
  /** Nothing set (no stroke, no effect): the title in the secondary colour, no body. */
  empty?: boolean;
  className?: string;
}) {
  const hasBody = Children.toArray(children).length > 0;
  return (
    <section
      className={cn("border-b border-hairline", hasBody && "pb-3", className)}
      aria-label={title}
    >
      <div className="flex h-10 items-center gap-1 pr-2 pl-4">
        <h3
          className={cn(
            "min-w-0 flex-1 truncate text-footnote font-semibold",
            empty ? "text-fg-2" : "text-fg",
          )}
        >
          {title}
        </h3>
        {action && <div className="flex shrink-0 items-center gap-0.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * One row of the grid: one cell per field column (two by default, `span` 2 for one wide
 * field) and the 24 px action column at the right.
 */
export function Row({
  children,
  action,
  span = 1,
  label,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  span?: 1 | 2;
  /** A small label above the row (Wecra's "additional labels"). */
  label?: string;
  className?: string;
}) {
  const cells = Children.toArray(children);
  return (
    <>
      {label && (
        <div className="pt-1 pr-2 pl-4 text-caption text-fg-3 select-none" aria-hidden="true">
          {label}
        </div>
      )}
      <div
        className={cn(
          "grid min-h-8 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24px] items-center gap-x-2 py-0.5 pr-2 pl-4",
          className,
        )}
      >
        {span === 2 ? (
          <div className="col-span-2 flex min-w-0 *:min-w-0 *:flex-1">{children}</div>
        ) : (
          cells.map((cell, i) => (
            <div key={i} className="flex min-w-0 *:min-w-0 *:flex-1">
              {cell}
            </div>
          ))
        )}
        <div className="col-start-3 flex size-6 items-center justify-center">{action}</div>
      </div>
    </>
  );
}

/** Free content inside a section, on the grid's insets. */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("pr-2 pl-4", className)}>{children}</div>;
}

const FIELD = "flex h-7 min-w-0 items-center rounded-full bg-field text-body";

export function NumberField({
  label,
  prefix,
  value,
  onCommit,
  step = 1,
  suffix,
  disabled,
  className,
  min,
  max,
}: {
  label: string;
  prefix: ReactNode;
  value: number | null;
  onCommit(value: number): void;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  min?: number;
  max?: number;
}) {
  const shown = value === null ? "" : String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const commit = (raw: string) => {
    const n = Number(raw.replace(",", ".").replace(/[^\d.+-]/g, ""));
    if (!Number.isFinite(n) || raw.trim() === "") {
      setText(shown);
      return;
    }
    const clamped = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, n),
    );
    if (value === null || Math.abs(clamped - value) > 1e-6) onCommit(clamped);
    setText(String(Math.round(clamped * 100) / 100));
  };
  return (
    <label
      title={label}
      className={cn(
        FIELD,
        "gap-1.5 px-2.5 focus-within:ring-2 focus-within:ring-focus/60",
        disabled && "opacity-50",
        className,
      )}
    >
      <span className="flex shrink-0 items-center text-footnote text-fg-3">{prefix}</span>
      <input
        aria-label={label}
        disabled={disabled}
        value={text}
        inputMode="decimal"
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.currentTarget.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(shown);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = Number(text) || value || 0;
            const next = base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            commit(String(next));
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-fg tabular-nums outline-none"
      />
      {suffix && <span className="shrink-0 text-footnote text-fg-3">{suffix}</span>}
    </label>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  prefix,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  prefix?: ReactNode;
  className?: string;
}) {
  return (
    <label
      title={label}
      className={cn(
        FIELD,
        "relative gap-1.5 pr-7 pl-2.5 focus-within:ring-2 focus-within:ring-focus/60",
        className,
      )}
    >
      {prefix && <span className="shrink-0 text-footnote text-fg-3">{prefix}</span>}
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const picked = options.find((o) => String(o.value) === raw);
          if (picked) onChange(picked.value);
        }}
        className="min-w-0 flex-1 appearance-none bg-transparent text-fg outline-none"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown
        size={12}
        className="pointer-events-none absolute right-2.5 text-fg-3"
        aria-hidden="true"
      />
    </label>
  );
}

/** A capsule of icon buttons (alignment, text alignment). */
export function ButtonGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <fieldset
      aria-label={label}
      className="flex h-7 min-w-0 items-center justify-around rounded-full bg-field px-0.5"
    >
      {children}
    </fieldset>
  );
}

export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  onPreview,
  onCommit,
  format = (v) => (v > 0 && min < 0 ? `+${v}` : String(v)),
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onPreview(value: number): void;
  onCommit(value: number): void;
  format?: (value: number) => string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="flex h-8 items-center gap-3 pr-2 pl-4 text-body">
      <span className="w-[76px] shrink-0 text-fg-2">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          onPreview(n);
        }}
        onPointerUp={() => onCommit(v)}
        onKeyUp={() => onCommit(v)}
        className="min-w-0 flex-1 accent-[var(--accent-default)]"
      />
      <span className="w-9 shrink-0 text-right text-footnote text-fg-2 tabular-nums">
        {format(v)}
      </span>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onCommit,
  trailing,
}: {
  label: string;
  value: string | null;
  onCommit(hex: string): void;
  /** Inside the capsule after the hex (the opacity). */
  trailing?: ReactNode;
}) {
  const [text, setText] = useState(value?.replace("#", "") ?? "");
  useEffect(() => setText(value?.replace("#", "") ?? ""), [value]);
  const commit = (raw: string) => {
    const hex = raw.trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      if (`#${hex.toUpperCase()}` !== value) onCommit(`#${hex.toUpperCase()}`);
    } else setText(value?.replace("#", "") ?? "");
  };
  return (
    <div className={cn(FIELD, "gap-2 pr-2.5 pl-1.5")}>
      <label
        className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]"
        style={{ background: value ?? "transparent" }}
      >
        <input
          type="color"
          aria-label={`${label} seç`}
          value={value ?? "#000000"}
          onChange={(e) => onCommit(e.target.value.toUpperCase())}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-body text-fg uppercase tabular-nums outline-none"
      />
      {trailing}
    </div>
  );
}

export function Chip({
  children,
  onClick,
  active,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-body whitespace-nowrap transition-colors",
        active ? "bg-accent-subtle text-accent-text" : "bg-control text-fg hover:bg-control-hover",
      )}
    >
      {children}
    </button>
  );
}
