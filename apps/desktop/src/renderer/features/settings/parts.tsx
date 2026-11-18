// Building blocks of the settings panes (Wecra "Settings row" and the tabs + table variant):
// a row (title + grey description left, control right, optional footer below, hairline under
// it), sub-headings, notes, the tabs / search / "+ …" toolbar, a table, a popup select and a
// confirmation dialog. Rows hide themselves while a search does not match them.
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, cn, SearchField, TagPill } from "../../components/ui/controls.tsx";
import { IconChevronDown } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { matches, type SettingsItem } from "./catalog.ts";

// --- search filter ------------------------------------------------------------------------------

export interface SettingsFilter {
  /** A sheet-wide search is shown (sections stack, tabs show every hit). */
  searching: boolean;
  visible(id: string): boolean;
}

const ALL: SettingsFilter = { searching: false, visible: () => true };

export const SettingsFilterContext = createContext<SettingsFilter>(ALL);

export function useSettingsFilter(): SettingsFilter {
  return useContext(SettingsFilterContext);
}

export function useRowVisible(id: string): boolean {
  return useContext(SettingsFilterContext).visible(id);
}

/** Whether `ref`'s element holds at least one settings row (follows DOM changes). */
export function useHasRows(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [has, setHas] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setHas(true);
      return;
    }
    const check = () => setHas(el.querySelector("[data-settings-row]") !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, active]);
  return has;
}

// --- pane, rows -------------------------------------------------------------------------------------

export function Pane({
  title,
  children,
  showTitle = true,
}: {
  title: string;
  children: ReactNode;
  showTitle?: boolean;
}) {
  const { searching } = useSettingsFilter();
  const ref = useRef<HTMLElement | null>(null);
  // While searching, a pane whose rows all hid itself (unavailable rows) disappears.
  const hasRows = useHasRows(ref, searching);
  return (
    <section ref={ref} aria-label={title} hidden={!hasRows} className="flex flex-col">
      {(showTitle || searching) && (
        <h3 className="mb-1 text-prose font-semibold text-fg">{title}</h3>
      )}
      {children}
    </section>
  );
}

// --- confirmation context ------------------------------------------------------------------------

export const ConfirmContext = createContext<(request: ConfirmRequest) => void>(() => undefined);

export function useConfirm(): (request: ConfirmRequest) => void {
  return useContext(ConfirmContext);
}

export function Row({
  item,
  id,
  title,
  detail,
  detailTone = "default",
  tag,
  children,
  footer,
  dimmed,
}: {
  item?: SettingsItem;
  id?: string;
  title?: ReactNode;
  detail?: ReactNode;
  detailTone?: "default" | "accent" | "danger";
  tag?: string;
  children?: ReactNode;
  footer?: ReactNode;
  dimmed?: boolean;
}) {
  const rowId = id ?? item?.id ?? "";
  const visible = useRowVisible(rowId);
  if (!visible) return null;
  const shownDetail = detail ?? item?.detail;
  return (
    <div
      data-settings-row={rowId}
      className={cn("border-b border-hairline py-3", dimmed && "opacity-60")}
    >
      <div className="flex min-h-[44px] items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-body-lg text-fg">
            {title ?? item?.title}
            {tag && <TagPill>{tag}</TagPill>}
          </div>
          {shownDetail ? (
            <div
              className={cn(
                "selectable mt-0.5 text-body whitespace-pre-line",
                detailTone === "accent"
                  ? "text-accent-text"
                  : detailTone === "danger"
                    ? "text-danger"
                    : "text-fg-2",
              )}
            >
              {shownDetail}
            </div>
          ) : null}
        </div>
        {children !== undefined && (
          <div className="flex shrink-0 items-center gap-2">{children}</div>
        )}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}

/** Small grey heading inside a pane ("Uzaktan erişim"); hidden when none of `ids` is shown. */
export function Subheader({ title, ids }: { title: string; ids?: string[] }) {
  const filter = useSettingsFilter();
  if (ids && !ids.some((id) => filter.visible(id))) return null;
  return <h4 className="mt-6 mb-1 text-footnote font-medium text-fg-3">{title}</h4>;
}

export function Note({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <p
      className={cn(
        "selectable py-3 text-body whitespace-pre-line",
        tone === "accent" ? "text-accent-text" : tone === "danger" ? "text-danger" : "text-fg-2",
      )}
    >
      {children}
    </p>
  );
}

/** Fields on the left, buttons on the right, a message under them (row footers). */
export function FormFooter({
  fields,
  buttons,
  message,
  messageTone = "default",
}: {
  fields: ReactNode;
  buttons: ReactNode;
  message?: string | null;
  messageTone?: "default" | "danger";
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">{fields}</div>
        <div className="flex shrink-0 items-center gap-2">{buttons}</div>
      </div>
      {message ? (
        <p
          role={messageTone === "danger" ? "alert" : "status"}
          className={cn(
            "selectable text-footnote",
            messageTone === "danger" ? "text-danger" : "text-fg-2",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

// --- tabs + table -------------------------------------------------------------------------------------

export function Toolbar({
  children,
  search,
  onSearch,
  placeholder,
  trailing,
}: {
  children?: ReactNode;
  search?: string;
  onSearch?(value: string): void;
  placeholder?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 pb-3">
      {children}
      <div className="flex-1" />
      {onSearch && (
        <SearchField
          className="w-[180px]"
          placeholder={placeholder ?? "Ara"}
          value={search ?? ""}
          aria-label={placeholder ?? "Ara"}
          onChange={(e) => onSearch(e.target.value)}
        />
      )}
      {trailing}
    </div>
  );
}

export interface TableColumn {
  title: string;
  /** px; undefined = takes the rest. */
  width?: number;
}

export interface TableRow {
  id: string;
  /** Words the toolbar's own search matches. */
  searchText: string;
  cells: ReactNode[];
  dimmed?: boolean;
}

export function Table({
  label,
  columns,
  rows,
  localQuery = "",
  empty,
}: {
  label: string;
  columns: TableColumn[];
  rows: TableRow[];
  localQuery?: string;
  empty: string;
}) {
  const filter = useSettingsFilter();
  const shown = rows.filter((r) => filter.visible(r.id) && matches(localQuery, r.searchText));
  if (filter.searching && shown.length === 0) return null;
  return (
    <table aria-label={label} className="w-full table-fixed border-collapse text-body">
      <colgroup>
        {columns.map((c) => (
          <col key={c.title || "actions"} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr className="h-8 border-b border-hairline text-footnote text-fg-3">
          {columns.map((c) => (
            <th key={c.title || "actions"} className="truncate px-3 text-left font-normal">
              {c.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="px-3 py-4 text-body text-fg-3">
              {localQuery.trim() ? "Sonuç yok." : empty}
            </td>
          </tr>
        ) : (
          shown.map((row) => (
            <tr
              key={row.id}
              data-settings-row={row.id}
              className={cn(
                "h-11 border-b border-hairline transition-colors duration-150 hover:bg-control",
                row.dimmed && "text-fg-2",
              )}
            >
              {row.cells.map((cell, i) => (
                <td key={columns[i]?.title || "actions"} className="min-w-0 px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// --- controls ----------------------------------------------------------------------------------------

/** Popup with a chevron (Claude's "Ask me ⌄"): a glass menu of options. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  width = 220,
}: {
  value: T;
  /** `heading`: a grey group title (e.g. the model menu's providers). */
  options: (
    | { value: T; label: string; disabled?: boolean }
    | { separator: true }
    | { heading: string }
  )[];
  onChange(value: T): void;
  label: string;
  width?: number;
}) {
  const current = options.find(
    (o): o is { value: T; label: string } => "value" in o && o.value === value,
  );
  const entries: MenuEntry[] = options.map((o, i) =>
    "separator" in o
      ? { type: "separator", id: `sep-${i}` }
      : "heading" in o
        ? { type: "label", id: `heading-${i}`, label: o.heading }
        : {
            id: o.value,
            label: o.label,
            checked: o.value === value,
            ...(o.disabled ? { disabled: true } : {}),
            onSelect: () => onChange(o.value),
          },
  );
  return (
    <MenuButton entries={entries} width={width} label={label} placement="bottom-end">
      {({ open, ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          {...props}
          aria-label={label}
          className={cn(
            "no-drag inline-flex h-7 items-center justify-between gap-2 rounded-full bg-field px-3 text-body text-fg",
            "shadow-[inset_0_0_0_1px_var(--border-hairline)] transition-colors duration-150 hover:bg-control",
            open && "bg-control",
          )}
          style={{ width }}
        >
          <span className="truncate">{current?.label ?? "—"}</span>
          <IconChevronDown size={14} className="shrink-0 text-fg-2" />
        </button>
      )}
    </MenuButton>
  );
}

/** Platform / status cell with a leading icon. */
export function TitleCell({
  icon,
  title,
  subtitle,
  tag,
  muted,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  tag?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon && <span className="flex shrink-0 text-icon">{icon}</span>}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn("truncate", muted ? "text-fg-2" : "text-fg")}>{title}</span>
          {tag && <TagPill>{tag}</TagPill>}
        </div>
        {subtitle && <div className="truncate text-footnote text-fg-3">{subtitle}</div>}
      </div>
    </div>
  );
}

// --- confirmation ----------------------------------------------------------------------------------

export interface ConfirmRequest {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  onConfirm(): void;
}

/** In-sheet alert (Esc / Vazgeç cancels, ↩ confirms). */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose(): void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!request) return;
    requestAnimationFrame(() => confirmRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [request, onClose]);
  if (!request) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click cancels (Esc does too)
    <div
      className="absolute inset-0 z-10 flex items-center justify-center rounded-[14px] bg-black/30 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-label={request.title}
        className="glass w-[380px] animate-pop-in rounded-[14px] p-5"
      >
        <h4 className="text-heading font-semibold text-fg">{request.title}</h4>
        <p className="selectable mt-2 text-body text-fg-2">{request.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            ref={confirmRef}
            variant={request.danger ? "danger" : "primary"}
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
