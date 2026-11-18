// FontPicker: the fonts installed on this Mac in a glass popover — search, every family shown in
// its own face, a styles flyout (each style in its weight), brand fonts pinned on top and the
// recently used ones under them. Picking a family row gives `{ family, style: null }`; picking a
// style gives that style. Used by Marka Kiti; made for the post editor's type controls too.
//
// Keyboard: ↑ ↓ move, → opens the styles of the active family (↑ ↓ inside, ← back), ⏎ picks,
// Esc closes.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultStyle,
  fontFace,
  type InstalledFontFamily,
  type InstalledFontStyle,
  type InstalledFonts,
  recentFonts,
  rememberFont,
  useInstalledFonts,
} from "../../lib/fonts.ts";
import { Button, cn, IconButton, SearchField, Spinner } from "./controls.tsx";
import { IconCheck, IconChevronDown, IconChevronRight, IconRefresh, IconType } from "./icons.tsx";
import { Popover } from "./popover.tsx";

export interface FontChoice {
  family: string;
  /** null: the family as a whole (its default style). */
  style: InstalledFontStyle | null;
}

export interface FontPickerProps {
  /** Current family (and style name); null shows the placeholder. */
  value: { family: string; style?: string | null } | null;
  onChange(choice: FontChoice): void;
  /** Accessible name of the trigger and the popover. */
  label: string;
  /** "field": a select-like pill showing the value in its face; "button": a capsule button. */
  trigger?: "field" | "button";
  /** Trigger text when there is no value (field) or the button's text (button). */
  placeholder?: string;
  buttonIcon?: ReactNode;
  /** Families pinned on top (brand fonts), in order. */
  pinned?: readonly string[];
  pinnedLabel?: string;
  /** Installed fonts; default: this Mac's (`useInstalledFonts`). */
  fonts?: InstalledFonts | null;
  /** A reason a family cannot be picked here (shown as its tooltip), or null. */
  disabledReason?: (family: string) => string | null;
  /** Families already chosen elsewhere (marked, still pickable). */
  marked?: readonly string[];
  className?: string;
  /** Start open (gallery). */
  defaultOpen?: boolean;
}

type Row =
  | { kind: "label"; key: string; text: string }
  | {
      kind: "family";
      key: string;
      family: string;
      data: InstalledFontFamily | null;
      disabled: string | null;
    };

const normalize = (text: string) =>
  text.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

/** Rows of the list: pinned, recent and all families (each family once), filtered by `query`. */
export function fontPickerRows(input: {
  families: readonly InstalledFontFamily[];
  pinned: readonly string[];
  recent: readonly string[];
  query: string;
  pinnedLabel: string;
  disabledReason?: ((family: string) => string | null) | undefined;
}): Row[] {
  const byName = new Map(input.families.map((f) => [f.family.toLowerCase(), f]));
  const q = normalize(input.query.trim());
  const qCompact = q.replace(/\s+/g, "");
  const matches = (family: string) =>
    !q || normalize(family).includes(q) || normalize(family).replace(/\s+/g, "").includes(qCompact);
  const used = new Set<string>();
  const rows: Row[] = [];
  const section = (title: string, names: readonly string[], keyPrefix: string) => {
    const list = names.filter((name) => {
      const k = name.toLowerCase();
      if (used.has(k) || !matches(name)) return false;
      return true;
    });
    if (list.length === 0) return;
    rows.push({ kind: "label", key: `label-${keyPrefix}`, text: title });
    for (const name of list) {
      used.add(name.toLowerCase());
      const data = byName.get(name.toLowerCase()) ?? null;
      rows.push({
        kind: "family",
        key: `${keyPrefix}-${name}`,
        family: data?.family ?? name,
        data,
        disabled: input.disabledReason?.(data?.family ?? name) ?? null,
      });
    }
  };
  section(input.pinnedLabel, input.pinned, "pinned");
  section(
    "Son kullanılanlar",
    input.recent.filter((name) => byName.has(name.toLowerCase())),
    "recent",
  );
  const all = input.families.filter((f) => matches(f.family)).map((f) => f.family);
  const allLeft = all.filter((name) => !used.has(name.toLowerCase()));
  if (allLeft.length > 0) {
    section(`Tüm yazı tipleri · ${all.length}`, allLeft, "all");
  }
  return rows;
}

function styleSummary(data: InstalledFontFamily | null): string {
  if (!data) return "yüklü değil";
  return data.styles.length === 1 ? "1 stil" : `${data.styles.length} stil`;
}

export function FontPicker({
  value,
  onChange,
  label,
  trigger = "field",
  placeholder = "Yazı tipi seç",
  buttonIcon,
  pinned = [],
  pinnedLabel = "Marka fontları",
  fonts: fontsProp,
  disabledReason,
  marked = [],
  className,
  defaultOpen = false,
}: FontPickerProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const installed = useInstalledFonts();
  const fonts = fontsProp === undefined ? (installed.data ?? null) : fontsProp;
  const loading = fontsProp === undefined && installed.isLoading;
  const [refreshing, setRefreshing] = useState(false);

  const current = value?.family ?? null;
  const currentStyle = useMemo(() => {
    if (!value) return null;
    const fam = fonts?.families.find((f) => f.family.toLowerCase() === value.family.toLowerCase());
    if (!fam) return null;
    return value.style
      ? (fam.styles.find((s) => s.name === value.style) ?? null)
      : defaultStyle(fam);
  }, [fonts, value]);

  const pick = (choice: FontChoice) => {
    rememberFont(choice.family);
    onChange(choice);
    setOpen(false);
  };

  return (
    <>
      {trigger === "button" ? (
        <Button
          ref={setAnchor}
          size="sm"
          icon={buttonIcon ?? <IconType size={12} strokeWidth={2} />}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={className}
          onClick={() => setOpen((o) => !o)}
        >
          {placeholder}
        </Button>
      ) : (
        <button
          ref={setAnchor}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "no-drag inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-field pr-2 pl-3 text-body text-fg",
            "shadow-[inset_0_0_0_1px_var(--border-hairline)] transition-colors duration-150 hover:bg-control",
            className,
          )}
        >
          <span
            className={cn("min-w-0 flex-1 truncate text-left", !current && "text-fg-3")}
            style={
              current
                ? {
                    fontFamily: fontFace(current),
                    fontWeight: currentStyle?.weight,
                    fontStyle: currentStyle?.italic ? "italic" : undefined,
                  }
                : undefined
            }
          >
            {current ? `${current}${value?.style ? ` · ${value.style}` : ""}` : placeholder}
          </span>
          <IconChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-3" />
        </button>
      )}
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        label={label}
        className="w-[340px] p-0!"
      >
        <FontPickerPanel
          fonts={fonts}
          loading={loading}
          refreshing={refreshing}
          onRefresh={
            fontsProp === undefined
              ? async () => {
                  setRefreshing(true);
                  try {
                    await installed.refresh();
                  } finally {
                    setRefreshing(false);
                  }
                }
              : undefined
          }
          current={current}
          currentStyle={value?.style ?? null}
          pinned={pinned}
          pinnedLabel={pinnedLabel}
          disabledReason={disabledReason}
          marked={marked}
          onPick={pick}
        />
      </Popover>
    </>
  );
}

function FontPickerPanel({
  fonts,
  loading,
  refreshing,
  onRefresh,
  current,
  currentStyle,
  pinned,
  pinnedLabel,
  disabledReason,
  marked,
  onPick,
}: {
  fonts: InstalledFonts | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: (() => Promise<void>) | undefined;
  current: string | null;
  currentStyle: string | null;
  pinned: readonly string[];
  pinnedLabel: string;
  disabledReason: ((family: string) => string | null) | undefined;
  marked: readonly string[];
  onPick(choice: FontChoice): void;
}) {
  const [query, setQuery] = useState("");
  const [recent] = useState(recentFonts);
  const rows = useMemo(
    () =>
      fontPickerRows({
        families: fonts?.families ?? [],
        pinned,
        recent,
        query,
        pinnedLabel,
        disabledReason,
      }),
    [fonts, pinned, recent, query, pinnedLabel, disabledReason],
  );
  const options = rows.flatMap((r, index) => (r.kind === "family" ? [index] : []));
  const [active, setActive] = useState<number>(-1);
  const [flyout, setFlyout] = useState<{ row: number; focus: number } | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markedSet = useMemo(() => new Set(marked.map((m) => m.toLowerCase())), [marked]);

  // The first option is active after each search; the current family when the panel opens.
  useEffect(() => {
    const currentIndex = current
      ? rows.findIndex((r) => r.kind === "family" && r.family === current)
      : -1;
    setActive(query ? (options[0] ?? -1) : currentIndex >= 0 ? currentIndex : (options[0] ?? -1));
    setFlyout(null);
  }, [query]);

  useLayoutEffect(() => {
    if (active < 0) return;
    rowRefs.current.get(active)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const rowAt = (index: number) => {
    const row = rows[index];
    return row?.kind === "family" ? row : null;
  };
  const flyoutRow = flyout ? rowAt(flyout.row) : null;
  const flyoutStyles = flyoutRow?.data?.styles ?? [];

  const move = (delta: 1 | -1) => {
    if (options.length === 0) return;
    const at = options.indexOf(active);
    const next =
      at < 0
        ? options[delta === 1 ? 0 : options.length - 1]
        : options[(at + delta + options.length) % options.length];
    setActive(next ?? -1);
    setFlyout(null);
  };

  const pickRow = (index: number) => {
    const row = rowAt(index);
    if (!row || row.disabled) return;
    onPick({ family: row.family, style: null });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (flyout && flyoutStyles.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const d = event.key === "ArrowDown" ? 1 : -1;
        setFlyout({
          row: flyout.row,
          focus: (flyout.focus + d + flyoutStyles.length) % flyoutStyles.length,
        });
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFlyout(null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const style = flyoutStyles[flyout.focus];
        if (style && flyoutRow && !flyoutRow.disabled) onPick({ family: flyoutRow.family, style });
        return;
      }
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowRight") {
      const row = rowAt(active);
      if (row?.data && row.data.styles.length > 0) {
        event.preventDefault();
        setFlyout({ row: active, focus: 0 });
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      pickRow(active);
    }
  };

  // Where the flyout sits: next to its row, on the side with room.
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; side: "right" | "left" } | null>(null);
  useLayoutEffect(() => {
    if (!flyout) {
      setFlyoutPos(null);
      return;
    }
    const row = rowRefs.current.get(flyout.row);
    const panel = panelRef.current;
    if (!row || !panel) return;
    const p = panel.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const side = p.right + 240 > window.innerWidth && p.left > 260 ? "left" : "right";
    // Next to the row, but kept inside the window (the list scrolls past 320 px).
    const count = rowAt(flyout.row)?.data?.styles.length ?? 0;
    const height = Math.min(320, count * 30 + 8);
    const lowest = window.innerHeight - 8 - height - p.top;
    setFlyoutPos({ top: Math.max(8 - p.top, Math.min(r.top - p.top - 4, lowest)), side });
  }, [flyout]);

  const empty = !loading && (fonts?.families.length ?? 0) === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keys reach the list from the search field
    <div ref={panelRef} className="relative" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1.5 p-2 pb-1.5">
        <SearchField
          aria-label="Yazı tipi ara"
          className="min-w-0 flex-1"
          placeholder="Yazı tipi ara"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        {onRefresh && (
          <IconButton
            icon={refreshing ? <Spinner size={12} /> : <IconRefresh size={13} strokeWidth={1.75} />}
            label="Listeyi yenile"
            size={28}
            disabled={refreshing}
            onClick={() => void onRefresh()}
          />
        )}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Yazı tipleri"
        className="max-h-[360px] overflow-y-auto px-1 pb-1"
        onScroll={() => setFlyout(null)}
      >
        {loading && (
          <p className="flex items-center gap-2 px-2.5 py-3 text-body text-fg-3">
            <Spinner size={12} /> Yazı tipleri okunuyor…
          </p>
        )}
        {empty && (
          <p className="px-2.5 py-3 text-body text-fg-3">
            {fonts?.error ?? "Bu Mac'te yazı tipi bulunamadı."}
          </p>
        )}
        {!loading && !empty && rows.length === 0 && (
          <p className="px-2.5 py-3 text-body text-fg-3">“{query}” ile eşleşen yazı tipi yok.</p>
        )}
        {rows.map((row, index) => {
          if (row.kind === "label") {
            return (
              <div key={row.key} className="px-2.5 pt-2 pb-1 text-caption text-fg-3">
                {row.text}
              </div>
            );
          }
          const isActive = index === active;
          const selected = current !== null && row.family.toLowerCase() === current.toLowerCase();
          const hasStyles = (row.data?.styles.length ?? 0) > 1;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the panel (active row)
            <div
              key={row.key}
              ref={(el) => {
                if (el) rowRefs.current.set(index, el);
                else rowRefs.current.delete(index);
              }}
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              aria-disabled={row.disabled ? true : undefined}
              title={row.disabled ?? undefined}
              data-active={isActive || undefined}
              onMouseEnter={() => {
                setActive(index);
                clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(
                  () => setFlyout(hasStyles ? { row: index, focus: -1 } : null),
                  hasStyles ? 140 : 220,
                );
              }}
              onMouseLeave={() => clearTimeout(hoverTimer.current)}
              onClick={() => pickRow(index)}
              style={{ contentVisibility: "auto", containIntrinsicSize: "0 30px" }}
              className={cn(
                "flex h-[30px] items-center gap-2 rounded-[8px] px-2.5",
                row.disabled ? "text-fg-3" : "text-fg",
                isActive && !row.disabled && "bg-control",
              )}
            >
              <span
                className="min-w-0 flex-1 truncate text-[15px]"
                style={{ fontFamily: fontFace(row.family) }}
              >
                {row.family}
              </span>
              {markedSet.has(row.family.toLowerCase()) && (
                <span className="shrink-0 text-caption text-fg-3">eklendi</span>
              )}
              <span
                className={cn("shrink-0 text-caption", row.data ? "text-fg-3" : "text-warning")}
              >
                {styleSummary(row.data)}
              </span>
              <span className="flex w-3.5 shrink-0 justify-end">
                {selected ? (
                  <IconCheck size={13} strokeWidth={2} className="text-fg-2" />
                ) : hasStyles ? (
                  <IconChevronRight size={13} className="text-fg-3" />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {fonts?.source === "sample" && (
        <p className="border-hairline border-t px-3 py-2 text-caption text-fg-3">{fonts.error}</p>
      )}
      {flyout && flyoutRow && flyoutPos && flyoutStyles.length > 0 && (
        <div
          role="listbox"
          aria-label={`${flyoutRow.family} stilleri`}
          style={{ top: flyoutPos.top }}
          className={cn(
            "glass absolute z-[99] max-h-[320px] w-[230px] animate-pop-in overflow-y-auto rounded-[12px] p-1",
            flyoutPos.side === "right" ? "left-[calc(100%+6px)]" : "right-[calc(100%+6px)]",
          )}
        >
          {flyoutStyles.map((style, i) => {
            const selected =
              current !== null &&
              flyoutRow.family.toLowerCase() === current.toLowerCase() &&
              currentStyle === style.name;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the panel
              <div
                key={style.postscriptName}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                onMouseEnter={() => setFlyout({ row: flyout.row, focus: i })}
                onClick={() => {
                  if (!flyoutRow.disabled) onPick({ family: flyoutRow.family, style });
                }}
                className={cn(
                  "flex h-[30px] items-center gap-2 rounded-[8px] px-2.5",
                  i === flyout.focus && "bg-control",
                )}
              >
                <span
                  className="min-w-0 flex-1 truncate text-[15px]"
                  style={{
                    fontFamily: fontFace(flyoutRow.family),
                    fontWeight: style.weight,
                    fontStyle: style.italic ? "italic" : "normal",
                  }}
                >
                  {style.name}
                </span>
                <span className="shrink-0 text-caption text-fg-3 tabular-nums">{style.weight}</span>
                {selected && <IconCheck size={13} strokeWidth={2} className="text-fg-2" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
