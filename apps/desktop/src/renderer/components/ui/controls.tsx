// Basic controls of the Wecra "Claude Code" components: every button, input, pill and
// segmented control is a capsule (radius = height / 2). Hover / pressed / selected / disabled /
// focus states follow the component variants (fill/control → control-hover → control-pressed,
// accent → accent-hover → accent-pressed, disabled 40 %). Text fields show nothing on focus;
// buttons get a quiet neutral ring for keyboard focus only (app.css).
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconCheck, IconSearch } from "./icons.tsx";
import { Tooltip } from "./tooltip.tsx";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// --- IconButton -----------------------------------------------------------------------------------

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  label: string;
  size?: 24 | 28 | 32;
  selected?: boolean;
  /** Shown in the tooltip after the label ("⌘K"). */
  shortcut?: string;
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 28, selected = false, shortcut, tooltip = true, className, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={selected || undefined}
      data-selected={selected || undefined}
      className={cn(
        "no-drag inline-flex shrink-0 items-center justify-center rounded-full text-icon",
        "transition-[background-color,color] duration-150 ease-out",
        "hover:bg-control active:bg-control-hover",
        "data-[selected]:bg-control-hover data-[selected]:text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      {icon}
    </button>
  );
  return tooltip ? (
    <Tooltip label={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
});

// --- Button ---------------------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
  secondary: "bg-control text-fg hover:bg-control-hover active:bg-control-pressed",
  ghost: "bg-transparent text-fg hover:bg-control active:bg-control-hover",
  danger: "bg-danger text-on-accent hover:opacity-[.88] active:opacity-75",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, ...rest },
  ref,
) {
  const height = size === "sm" ? 24 : size === "lg" ? 32 : 28;
  return (
    <button
      ref={ref}
      type="button"
      data-variant={variant}
      className={cn(
        "no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full whitespace-nowrap",
        "text-body font-medium transition-[background-color,opacity] duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "px-2.5 text-footnote" : "px-3",
        BUTTON_VARIANTS[variant],
        className,
      )}
      style={{ height }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

// --- SegmentedControl -----------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Shown after the label in the tertiary colour (filter counts). */
  count?: number;
  /** "danger": the count is a problem count (failed checks), shown in red. */
  countTone?: "neutral" | "danger";
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: SegmentOption<T>[];
  value: T | null;
  onChange(value: T): void;
  label: string;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = value ? refs.current.get(value) : undefined;
    setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [value, options]);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "no-drag relative inline-flex h-7 items-center rounded-full bg-field p-0.5",
        className,
      )}
    >
      {thumb && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 h-6 rounded-full bg-popover shadow-sm transition-[left,width] duration-200 ease-snap"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled segment with radio-group keyboard handling
          <button
            key={option.value}
            ref={(el) => {
              if (el) refs.current.set(option.value, el);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const index = options.findIndex((o) => o.value === value);
              const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const next = options[(index + delta + options.length) % options.length];
              if (next) {
                onChange(next.value);
                refs.current.get(next.value)?.focus();
              }
            }}
            className={cn(
              "relative z-10 h-6 rounded-full px-2.5 text-body transition-colors duration-150",
              selected ? "text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cn(
                  "ml-1 tabular-nums",
                  option.countTone === "danger" ? "font-medium text-danger" : "text-fg-3",
                )}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- TextField / SearchField ----------------------------------------------------------------------

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  invalid?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { leading, invalid, className, disabled, ...rest },
  ref,
) {
  return (
    <label
      data-disabled={disabled || undefined}
      className={cn(
        "no-drag group inline-flex h-7 items-center gap-1.5 rounded-full bg-field px-3",
        "shadow-[inset_0_0_0_1px_var(--border-hairline)] transition-[background-color,box-shadow] duration-150",
        "hover:bg-control focus-within:bg-field",
        invalid && "shadow-[inset_0_0_0_1px_var(--status-danger)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
    >
      {leading && <span className="flex shrink-0 text-fg-3">{leading}</span>}
      <input
        ref={ref}
        disabled={disabled}
        className="selectable h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-3 focus-visible:shadow-none"
        {...rest}
      />
    </label>
  );
});

export const SearchField = forwardRef<HTMLInputElement, TextFieldProps>(
  function SearchField(props, ref) {
    return (
      <TextField
        ref={ref}
        type="search"
        leading={<IconSearch size={12} strokeWidth={1.75} />}
        placeholder="Ara"
        {...props}
      />
    );
  },
);

// --- Switch ---------------------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "no-drag relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200 ease-snap",
        checked ? "bg-accent" : "bg-control-pressed",
        "disabled:opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-snap",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// --- Checkbox -------------------------------------------------------------------------------------

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  children,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  label?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <span className={cn("inline-flex items-center gap-2", disabled && "opacity-40")}>
      {/* biome-ignore lint/a11y/useSemanticElements: custom-drawn checkbox with the native role */}
      <button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "no-drag inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] transition-colors duration-150",
          checked
            ? "bg-accent text-on-accent hover:bg-accent-hover"
            : "bg-field shadow-[inset_0_0_0_1px_var(--border-default)] hover:bg-control",
        )}
      >
        {checked && <IconCheck size={12} strokeWidth={2.5} />}
      </button>
      {children && (
        <label htmlFor={id} className="text-body text-fg">
          {children}
        </label>
      )}
    </span>
  );
}

// --- TagPill --------------------------------------------------------------------------------------

export type TagTone = "neutral" | "accent" | "success" | "danger" | "warning";

const TAG_TONES: Record<TagTone, string> = {
  neutral: "bg-control text-fg-2",
  accent: "bg-accent-subtle text-accent-text",
  success: "bg-[color-mix(in_srgb,var(--status-success)_16%,transparent)] text-success",
  danger: "bg-[color-mix(in_srgb,var(--status-danger)_16%,transparent)] text-danger",
  warning: "bg-[color-mix(in_srgb,var(--status-warning)_18%,transparent)] text-warning",
};

export function TagPill({ tone = "neutral", children }: { tone?: TagTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-full px-1.5 text-caption whitespace-nowrap",
        TAG_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// --- progress glyphs --------------------------------------------------------------------------------

/** Claude Code's working glyph: four orange dots pulsing in turn (grey and still while queued). */
export function WorkingDots({ animated = true, size = 16 }: { animated?: boolean; size?: number }) {
  const dots: [number, number][] = [
    [8, 3],
    [13, 8],
    [8, 13],
    [3, 8],
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={animated ? "text-accent" : "text-fg-3"}
      data-testid="working-dots"
    >
      {dots.map(([x, y], i) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={1.6}
          fill="currentColor"
          style={
            animated
              ? {
                  animation: `studio-dot 1.2s var(--ease-out) ${i * 0.15}s infinite`,
                  transformOrigin: `${x}px ${y}px`,
                }
              : undefined
          }
        />
      ))}
    </svg>
  );
}

/** Small circular spinner (running rows). */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ animation: "studio-spin 0.9s linear infinite" }}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".25"
        strokeWidth="1.6"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The usage ring of the status line (blue; orange near the limit). */
export function UsageRing({
  percent,
  warning,
  size = 14,
}: {
  percent: number;
  warning?: boolean;
  size?: number;
}) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="-rotate-90">
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="var(--fill-control-pressed)"
        strokeWidth="1.75"
      />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke={warning ? "var(--accent-default)" : "var(--status-info)"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * c} ${c}`}
        className="transition-[stroke-dasharray] duration-500 ease-out"
      />
    </svg>
  );
}

/** Thin progress bar (usage meters). */
export function Meter({
  percent,
  tone = "info",
}: {
  percent: number;
  tone?: "info" | "warning" | "danger";
}) {
  const color = { info: "bg-info", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-control">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out", color)}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

/** Small "Kbd" chip (shortcut hints). */
export function Kbd({ children }: { children: ReactNode }) {
  return <span className="text-caption text-fg-3">{children}</span>;
}
