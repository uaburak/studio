// One modal behaviour for every dialog, sheet and palette: focus moves in when it opens, Tab
// and ⇧Tab stay inside it (a focus trap), Esc closes it (an open menu first), and focus goes
// back to where it was when it closes. Modals stack: only the top one answers the keys.
import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The elements Tab reaches inside `root`, in order (hidden ones left out). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[hidden],[inert]") && el.getAttribute("aria-hidden") !== "true",
  );
}

/** Open modals, bottom to top. */
const stack: symbol[] = [];

export function isTopModal(token: symbol): boolean {
  return stack.at(-1) === token;
}

/** Floating parts (menus, popovers) live in portals outside the panel but belong to it. */
function inFloatingLayer(el: Element | null): boolean {
  return Boolean(el?.closest("[data-floating-ui-portal],[data-studio-menu]"));
}

export interface ModalOptions {
  open: boolean;
  /** Esc (null: the modal handles Esc itself). */
  onClose: (() => void) | null;
  /** What gets focus first: a selector inside the panel; default `[data-autofocus]`, then the panel. */
  initialFocus?: string;
}

/**
 * Makes `panel` modal while `open`. The panel needs `tabIndex={-1}` (it takes focus when it has
 * nothing focusable).
 */
export function useModal(panel: RefObject<HTMLElement | null>, options: ModalOptions): void {
  const closeRef = useRef(options.onClose);
  closeRef.current = options.onClose;
  const initial = options.initialFocus ?? "[data-autofocus]";
  const { open } = options;

  useEffect(() => {
    if (!open) return;
    const token = Symbol("modal");
    stack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const root = panel.current;
      if (!root || root.contains(document.activeElement)) return;
      const target = root.querySelector<HTMLElement>(initial) ?? root;
      target.focus({ preventScroll: true });
    });

    const onKey = (event: KeyboardEvent) => {
      if (!isTopModal(token)) return;
      const root = panel.current;
      if (!root) return;
      if (event.key === "Escape") {
        const close = closeRef.current;
        if (!close) return;
        // An open menu closes first (its trigger may have kept the focus).
        const menu = document.querySelector<HTMLElement>("[data-studio-menu]");
        if (menu && !root.contains(menu)) {
          if (!menu.contains(event.target as Node)) {
            event.preventDefault();
            event.stopPropagation();
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const active = document.activeElement;
      // A menu or popover of the modal handles its own keys.
      if (active && !root.contains(active) && inFloatingLayer(active)) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items.at(-1) as HTMLElement;
      const inside = active instanceof HTMLElement && root.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      const index = stack.indexOf(token);
      if (index !== -1) stack.splice(index, 1);
      // Back to where the user was (if it is still there).
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, panel, initial]);
}
