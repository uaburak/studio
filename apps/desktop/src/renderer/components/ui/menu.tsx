// Glass menus (Wecra "Menu item", "Menu separator", "Menu label"): check marks, shortcut
// letters, submenus, danger items; full keyboard navigation (lib/menu-nav.ts).
import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  firstSelectable,
  isSelectable,
  type MenuEntry,
  type MenuItemEntry,
  menuKey,
} from "../../lib/menu-nav.ts";
import { cn } from "./controls.tsx";
import { IconCheck, IconChevronRight } from "./icons.tsx";

export type { MenuEntry, MenuItemEntry } from "../../lib/menu-nav.ts";

type CloseReason = "select" | "escape" | "outside" | "back";

export interface MenuProps {
  anchor: Element | VirtualElement | null;
  open: boolean;
  entries: MenuEntry[];
  onClose(reason: CloseReason): void;
  placement?: Placement;
  /** Minimum width in px (default 220). */
  width?: number;
  label?: string;
  nested?: boolean;
  /** Focus the first item on open (keyboard-opened menus). */
  autoFocusFirst?: boolean;
  /** Render in place (gallery): no portal, no positioning, no outside-click handling. */
  inline?: boolean;
}

export function Menu({
  anchor,
  open,
  entries,
  onClose,
  placement = "bottom-start",
  width = 220,
  label,
  nested = false,
  autoFocusFirst = false,
  inline = false,
}: MenuProps) {
  const [active, setActive] = useState(-1);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const itemRefs = useRef(new Map<number, HTMLDivElement>());
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const {
    refs,
    floatingStyles,
    placement: finalPlacement,
  } = useFloating({
    open,
    placement,
    middleware: [
      offset(nested ? { mainAxis: 2, crossAxis: -5 } : 4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    refs.setPositionReference(anchor);
  }, [refs, anchor]);

  // Reset when the menu opens (entries may be rebuilt on every render; they do not reset it).
  const openingRef = useRef({ entries, autoFocusFirst, inline });
  openingRef.current = { entries, autoFocusFirst, inline };
  useLayoutEffect(() => {
    if (!open) return;
    const { entries: list, autoFocusFirst: first } = openingRef.current;
    setActive(first ? firstSelectable(list) : -1);
    setSubmenu(null);
    if (!openingRef.current.inline) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Outside clicks close the whole menu tree (clicks inside any Studio menu do not).
  useEffect(() => {
    if (!open || nested || inline) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("[data-studio-menu]")) return;
      if (anchor instanceof Element && anchor.contains(target)) return;
      onClose("outside");
    };
    const onBlur = () => onClose("outside");
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, nested, inline, anchor, onClose]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const activate = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!isSelectable(entry)) return;
      if (entry.submenu) {
        setActive(index);
        setSubmenu(index);
        return;
      }
      onClose("select");
      entry.onSelect?.();
    },
    [entries, onClose],
  );

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (submenu !== null) return; // the submenu handles keys while open
    const result = menuKey(entries, active, event.key, nested);
    if (result.kind === "none") return;
    event.preventDefault();
    event.stopPropagation();
    switch (result.kind) {
      case "move":
        setActive(result.index);
        itemRefs.current.get(result.index)?.scrollIntoView({ block: "nearest" });
        break;
      case "activate":
        activate(result.index);
        break;
      case "openSubmenu":
        setActive(result.index);
        setSubmenu(result.index);
        break;
      case "close":
        onClose(result.all ? "escape" : "back");
        break;
    }
  };

  const submenuEntry =
    submenu !== null ? (entries[submenu] as MenuItemEntry | undefined) : undefined;

  const panel = (
    <div
      ref={(el) => {
        menuRef.current = el;
        if (!inline) refs.setFloating(el);
      }}
      data-studio-menu=""
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={
        inline
          ? { minWidth: width, width }
          : {
              ...floatingStyles,
              minWidth: width,
              ["--pop-from" as string]: finalPlacement.startsWith("top") ? "4px" : "-4px",
            }
      }
      className={cn(
        "glass z-[90] max-h-[70vh] overflow-y-auto rounded-[12px] p-1 text-body text-fg outline-none",
        !inline && "animate-pop-in",
      )}
    >
      {entries.map((entry, index) => {
        if (entry.type === "separator") {
          return (
            <hr
              key={entry.id ?? `sep-${index}`}
              className="mx-2.5 my-1 h-px border-0 bg-hairline"
            />
          );
        }
        if (entry.type === "label") {
          return (
            <div
              key={entry.id ?? `label-${index}`}
              className="px-2.5 pt-1.5 pb-1 text-caption text-fg-3"
            >
              {entry.label}
            </div>
          );
        }
        const isActive = index === active;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the menu (active item)
          <div
            key={entry.id}
            ref={(el) => {
              if (el) itemRefs.current.set(index, el);
              else itemRefs.current.delete(index);
            }}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={entry.disabled || undefined}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? submenu === index : undefined}
            data-active={isActive || undefined}
            onMouseEnter={() => {
              if (entry.disabled) return;
              setActive(index);
              clearTimeout(hoverTimer.current);
              hoverTimer.current = setTimeout(
                () => setSubmenu(entry.submenu ? index : null),
                entry.submenu ? 120 : 200,
              );
            }}
            onMouseLeave={() => clearTimeout(hoverTimer.current)}
            onClick={() => activate(index)}
            className={cn(
              "flex h-7 items-center gap-2 rounded-[8px] px-2.5 whitespace-nowrap",
              entry.disabled ? "text-fg-3" : entry.danger ? "text-danger" : "text-fg",
              isActive && !entry.disabled && "bg-control",
            )}
          >
            {entry.icon && (
              <span className="flex size-4 shrink-0 items-center justify-center text-icon">
                {entry.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {entry.label}
              {entry.detail && <span className="text-fg-2"> · {entry.detail}</span>}
            </span>
            {entry.checked && (
              <IconCheck size={14} strokeWidth={1.75} className="shrink-0 text-fg-2" />
            )}
            {entry.shortcut && (
              <span className="w-3 shrink-0 text-right text-caption text-fg-3">
                {entry.shortcut}
              </span>
            )}
            {entry.submenu && <IconChevronRight size={14} className="shrink-0 text-fg-2" />}
          </div>
        );
      })}
    </div>
  );
  if (inline) return panel;
  return (
    <FloatingPortal>
      {panel}
      {submenuEntry?.submenu && submenu !== null && (
        <Menu
          anchor={itemRefs.current.get(submenu) ?? null}
          open
          nested
          autoFocusFirst
          entries={submenuEntry.submenu}
          placement="right-start"
          width={180}
          onClose={(reason) => {
            setSubmenu(null);
            if (reason === "back") menuRef.current?.focus({ preventScroll: true });
            else onClose(reason);
          }}
        />
      )}
    </FloatingPortal>
  );
}

/** A trigger + its menu. `children` renders the trigger with the props to spread on it. */
export function MenuButton({
  entries,
  placement,
  width,
  label,
  children,
}: {
  entries: MenuEntry[] | (() => MenuEntry[]);
  placement?: Placement;
  width?: number;
  label?: string;
  children: (props: {
    ref: (el: HTMLElement | null) => void;
    onClick: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    open: boolean;
  }) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [viaKeyboard, setViaKeyboard] = useState(false);
  const resolved = open ? (typeof entries === "function" ? entries() : entries) : [];
  const close = useCallback(
    (reason: CloseReason) => {
      setOpen(false);
      if (reason === "escape") anchor?.focus();
    },
    [anchor],
  );
  return (
    <>
      {children({
        ref: setAnchor,
        onClick: () => {
          setViaKeyboard(false);
          setOpen((o) => !o);
        },
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setViaKeyboard(true);
            setOpen(true);
          }
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        open,
      })}
      <Menu
        anchor={anchor}
        open={open}
        entries={resolved}
        onClose={close}
        placement={placement}
        width={width}
        label={label}
        autoFocusFirst={viaKeyboard}
      />
    </>
  );
}

/** Right-click menu at the pointer. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const anchor: VirtualElement | null = state
    ? {
        getBoundingClientRect: () => new DOMRect(state.x, state.y, 0, 0),
      }
    : null;
  return {
    open(event: React.MouseEvent, entries: MenuEntry[]) {
      event.preventDefault();
      setState({ x: event.clientX, y: event.clientY, entries });
    },
    element: (
      <Menu
        anchor={anchor}
        open={state !== null}
        entries={state?.entries ?? []}
        onClose={() => setState(null)}
        placement="bottom-start"
      />
    ),
  };
}
