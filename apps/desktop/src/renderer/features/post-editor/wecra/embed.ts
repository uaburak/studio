// How Wecra's editor (vendored, see scripts/vendor-wecra.mjs) runs inside Studio's post editor:
// the vendored copy's embedding patches read `globalThis.__wecraEmbed`.
//
// - `studio`: Wecra's EditorApp leaves its own rail, panels, toolbar and "?" out — Studio draws
//   Wecra's Design panel, Layers and toolbar in its own places (right panel, canvas card, dock);
// - `devStore`: Wecra's browser store keeps nothing (no demo files, nothing in Studio's
//   localStorage): the post's document comes from Studio;
// - `ownsEvent`: Wecra's keys and clipboard only for what happens in the editor's places, so
//   Studio's fields, buttons, chat and menus keep theirs (⌘[ / ⌘] only on the canvas and its
//   layers: elsewhere they are the app's back / forward).
import { memoryStorage } from "@/store/memory/kv";

/** Marks an element (and what is inside) as one of the editor's places. */
export const WECRA_REGION = "data-wecra-region";

/** Wecra's overlay root (menus, popovers, tooltips, dialogs: ds/overlay/Portal.tsx). */
export const WECRA_OVERLAYS = "ds-overlays";

const inRegion = (node: Node | null): boolean => {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest(`[${WECRA_REGION}],#${WECRA_OVERLAYS}`);
};

/** ⌘[ / ⌘]: Wecra's send backward / bring forward, the app's back / forward everywhere else. */
const isNavKey = (event: Event): boolean => {
  if (event.type !== "keydown" && event.type !== "keyup") return false;
  const e = event as KeyboardEvent;
  return (
    e.metaKey &&
    !e.ctrlKey &&
    (e.code === "BracketLeft" || e.code === "BracketRight" || e.key === "[" || e.key === "]")
  );
};

/** On the canvas or in Wecra's layers (where Wecra's ⌘[ / ⌘] apply). */
const onCanvas = (node: Node | null): boolean => {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest(`[${WECRA_REGION}="canvas"],[${WECRA_REGION}="layers"]`);
};

/** Whether a key or clipboard event is the editor's. */
export function ownsEvent(event: Event): boolean {
  const target = event.target as Node | null;
  // ⌘[ / ⌘] are the editor's only on its canvas and layers (E8): with the focus elsewhere — the
  // page itself included — they go back and forward in the app.
  if (isNavKey(event)) return onCanvas(target);
  if (event.type === "copy" || event.type === "cut") {
    // Text selected in Studio's page (the chat, the caption): the browser copies it.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && !inRegion(selection.anchorNode)) return false;
  }
  if (!target || target === document.body || target === document.documentElement) return true;
  return inRegion(target);
}

let installed = false;

/** Before Wecra's modules run anything (idempotent). */
export function installWecraEmbed(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __wecraEmbed?: unknown }).__wecraEmbed = {
    studio: true,
    devStore: { seed: false, openStorage: async () => memoryStorage() },
    ownsEvent,
  };
}

installWecraEmbed();
