// Keyboard navigation of menus (pure): arrows skip separators, labels and disabled items;
// a shortcut letter picks its item; Home / End jump.
import type { ReactNode } from "react";

export interface MenuItemEntry {
  type?: "item";
  id: string;
  label: string;
  /** Grey text after the label ("· Orta"). */
  detail?: string;
  /** Letter / digit shown at the right; pressing it picks the item. */
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry =
  | MenuItemEntry
  | { type: "separator"; id?: string }
  | { type: "label"; id?: string; label: string };

export function isSelectable(entry: MenuEntry | undefined): entry is MenuItemEntry {
  return (
    entry !== undefined && (entry.type === undefined || entry.type === "item") && !entry.disabled
  );
}

/** Next selectable index from `current` moving by `delta` (wraps); -1 when there is none. */
export function moveActive(entries: MenuEntry[], current: number, delta: 1 | -1): number {
  const n = entries.length;
  if (n === 0) return -1;
  let index = current;
  for (let step = 0; step < n; step++) {
    index = current < 0 && step === 0 ? (delta === 1 ? 0 : n - 1) : (index + delta + n) % n;
    if (isSelectable(entries[index])) return index;
  }
  return -1;
}

export function firstSelectable(entries: MenuEntry[]): number {
  return entries.findIndex((e) => isSelectable(e));
}

export function lastSelectable(entries: MenuEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (isSelectable(entries[i])) return i;
  return -1;
}

/** The item whose shortcut is `key` (case-insensitive), else -1. */
export function shortcutIndex(entries: MenuEntry[], key: string): number {
  if (key.length !== 1) return -1;
  const k = key.toLocaleLowerCase("tr-TR");
  return entries.findIndex((e) => isSelectable(e) && e.shortcut?.toLocaleLowerCase("tr-TR") === k);
}

export type MenuKeyResult =
  | { kind: "move"; index: number }
  | { kind: "activate"; index: number }
  | { kind: "openSubmenu"; index: number }
  | { kind: "close"; all: boolean }
  | { kind: "none" };

/** What a key does in a menu (`nested`: this menu is a submenu). */
export function menuKey(
  entries: MenuEntry[],
  active: number,
  key: string,
  nested: boolean,
): MenuKeyResult {
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: moveActive(entries, active, 1) };
    case "ArrowUp":
      return { kind: "move", index: moveActive(entries, active, -1) };
    case "Home":
      return { kind: "move", index: firstSelectable(entries) };
    case "End":
      return { kind: "move", index: lastSelectable(entries) };
    case "Enter":
    case " ": {
      const entry = entries[active];
      if (!isSelectable(entry)) return { kind: "none" };
      return entry.submenu
        ? { kind: "openSubmenu", index: active }
        : { kind: "activate", index: active };
    }
    case "ArrowRight": {
      const entry = entries[active];
      return isSelectable(entry) && entry.submenu
        ? { kind: "openSubmenu", index: active }
        : { kind: "none" };
    }
    case "ArrowLeft":
      return nested ? { kind: "close", all: false } : { kind: "none" };
    case "Escape":
      return { kind: "close", all: !nested };
    case "Tab":
      return { kind: "close", all: true };
    default: {
      const index = shortcutIndex(entries, key);
      if (index < 0) return { kind: "none" };
      const entry = entries[index] as MenuItemEntry;
      return entry.submenu ? { kind: "openSubmenu", index } : { kind: "activate", index };
    }
  }
}
