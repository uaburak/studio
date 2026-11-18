// Small inspector controls: number fields that commit on ↩ / blur (↑ ↓ step, ⇧ ×10), sections,
// a slider, a colour field.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../../components/ui/controls.tsx";

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-b border-hairline px-4 py-3", className)} aria-label={title}>
      <div className="mb-2 flex h-5 items-center justify-between">
        <h3 className="text-footnote font-semibold text-fg">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

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
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] bg-field px-2 text-body focus-within:ring-2 focus-within:ring-focus/60",
        disabled && "opacity-50",
        className,
      )}
    >
      <span className="shrink-0 text-footnote text-fg-3">{prefix}</span>
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

export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onPreview(value: number): void;
  onCommit(value: number): void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="flex h-7 items-center gap-3 text-body">
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
        {v > 0 ? `+${v}` : v}
      </span>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string | null;
  onCommit(hex: string): void;
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
    <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[8px] bg-field px-2">
      <label
        className="relative size-4 shrink-0 cursor-pointer overflow-hidden rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]"
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
