import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";
import type { Tone } from "../lib/labels.ts";
import { IconChevronDown } from "./icons.tsx";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// --- Button ------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-bg hover:bg-ink/85 disabled:bg-ink/40",
  accent: "bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50",
  secondary:
    "bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40",
  danger: "text-bad ring-1 ring-inset ring-bad/40 hover:bg-bad/10 disabled:opacity-40",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background-color,filter,box-shadow] select-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cx("animate-spin", className)}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".25"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// --- Badges ------------------------------------------------------------------

export function Badge({
  tone = "neutral",
  children,
  dot = true,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
  title?: string | undefined;
}) {
  return (
    <span
      title={title}
      className={cx(
        `tint-${tone} inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap`,
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-md bg-surface-2 px-2 text-xs font-medium text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[12px] tracking-tight", className)}>{children}</span>;
}

// --- Surfaces ----------------------------------------------------------------

export function Card({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
}) {
  return (
    <As className={cx("rounded-2xl bg-surface shadow-card ring-1 ring-line/70", className)}>
      {children}
    </As>
  );
}

export function SectionTitle({
  children,
  action,
  id,
}: {
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <h2 id={id} className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

// --- Form fields -------------------------------------------------------------

const fieldBase =
  "w-full rounded-xl bg-surface px-3.5 text-[15px] text-ink ring-1 ring-inset ring-line-strong placeholder:text-ink-3 transition-shadow focus:ring-2 focus:ring-ink focus:outline-none disabled:opacity-60 aria-invalid:ring-bad";

export function Field({
  label,
  hint,
  error,
  children,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  optional?: boolean;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2 text-[13px] font-medium text-ink">
        {label}
        {optional && <span className="text-xs font-normal text-ink-3">isteğe bağlı</span>}
      </label>
      {children({
        id,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(fieldBase, "h-11", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea ref={ref} className={cx(fieldBase, "py-2.5 leading-relaxed", className)} {...rest} />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx("relative", className)}>
      <select className={cx(fieldBase, "h-11 appearance-none pr-9")} {...rest}>
        {children}
      </select>
      <IconChevronDown
        size={16}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3"
      />
    </div>
  );
}

/** Compact select used in filter bars. */
export function FilterSelect({
  label,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={cx("relative inline-flex items-center", className)}>
      <span className="sr-only">{label}</span>
      <select
        className="h-9 w-full appearance-none rounded-lg bg-surface pr-8 pl-3 text-[13px] font-medium text-ink ring-1 ring-inset ring-line-strong focus:ring-2 focus:ring-ink focus:outline-none"
        {...rest}
      >
        {children}
      </select>
      <IconChevronDown size={14} className="pointer-events-none absolute right-2.5 text-ink-3" />
    </label>
  );
}

/** Segmented control backed by radio inputs (keyboard: arrow keys). */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  name: string;
  value: T;
  options: readonly { value: T; label: ReactNode; hint?: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div
        className={cx(
          "inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1",
          size === "sm" && "rounded-lg",
        )}
      >
        {options.map((o) => (
          <label
            key={o.value}
            title={o.hint}
            className={cx(
              "relative flex cursor-pointer items-center gap-1.5 rounded-lg font-medium whitespace-nowrap text-ink-2 transition-colors has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-9 px-3.5 text-[13px]",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset ring-line transition-colors has-[:checked]:bg-surface-2 has-[:checked]:ring-ink/30 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-md ring-1 ring-line-strong ring-inset peer-checked:bg-ink peer-checked:ring-ink"
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="size-3 text-bg" aria-hidden="true">
            <path d="M2.5 6.5l2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.8" fill="none" />
          </svg>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-ink">{children}</span>
        {description && <span className="text-xs text-ink-3">{description}</span>}
      </span>
    </label>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        className="h-full rounded-full bg-info transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-ink-3">{item.label}</dt>
          <dd className="min-w-0 break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CodeBlock({ children, label }: { children: string; label: string }) {
  return (
    <pre
      title={label}
      className="max-h-96 overflow-auto rounded-xl bg-surface-2 p-4 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink"
    >
      {children}
    </pre>
  );
}
