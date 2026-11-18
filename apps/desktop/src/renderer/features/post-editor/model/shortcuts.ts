// The editor's keyboard shortcuts (the design's "Özellikler ve kısayollar" table, plus K for the
// scale tool and ⌘A). Matching uses `KeyboardEvent.code` for letters and digits (the Turkish
// layout's letters sit on the same keys) and `key` for punctuation.
export type ShortcutCommand =
  | "tool.move"
  | "tool.hand"
  | "tool.scale"
  | "slide.add"
  | "layer.text"
  | "layer.shape"
  | "image.place"
  | "ai.focus"
  | "undo"
  | "redo"
  | "layer.duplicate"
  | "layer.delete"
  | "layer.group"
  | "layer.forward"
  | "layer.backward"
  | "slide.prev"
  | "slide.next"
  | "slide.duplicate"
  | "zoom.fit"
  | "zoom.selection"
  | "zoom.100"
  | "zoom.in"
  | "zoom.out"
  | "view.safeArea"
  | "view.rulers"
  | "view.snapping"
  | "versions.open"
  | "versions.save"
  | "preview"
  | "approve"
  | "schedule"
  | "caption.tab"
  | "text.edit"
  | "escape"
  | "select.all";

export interface Shortcut {
  command: ShortcutCommand;
  /** As the table and tooltips show it. */
  keys: string;
  label: string;
  /** `KeyboardEvent.code` (letters, digits, Enter, Backspace …) or `key` (punctuation). */
  code?: string;
  key?: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Also matches this code (⌫ and Delete). */
  alsoCode?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { command: "tool.move", keys: "V", label: "Seç", code: "KeyV" },
  { command: "tool.hand", keys: "H", label: "El (kaydır)", code: "KeyH" },
  { command: "tool.scale", keys: "K", label: "Ölçekle", code: "KeyK" },
  { command: "slide.add", keys: "F", label: "Kare ekle", code: "KeyF" },
  { command: "layer.text", keys: "T", label: "Metin", code: "KeyT" },
  { command: "layer.shape", keys: "R", label: "Şekil", code: "KeyR" },
  {
    command: "image.place",
    keys: "⇧⌘K",
    label: "Görsel yerleştir",
    code: "KeyK",
    meta: true,
    shift: true,
  },
  {
    command: "ai.focus",
    keys: "⌘K",
    label: "Sohbet (post hakkında yaz)",
    code: "KeyK",
    meta: true,
  },
  { command: "redo", keys: "⇧⌘Z", label: "Yinele", code: "KeyZ", meta: true, shift: true },
  { command: "undo", keys: "⌘Z", label: "Geri al", code: "KeyZ", meta: true },
  {
    command: "slide.duplicate",
    keys: "⇧⌘D",
    label: "Kareyi çoğalt",
    code: "KeyD",
    meta: true,
    shift: true,
  },
  { command: "layer.duplicate", keys: "⌘D", label: "Çoğalt", code: "KeyD", meta: true },
  { command: "layer.delete", keys: "⌫", label: "Sil", code: "Backspace", alsoCode: "Delete" },
  { command: "layer.group", keys: "⌘G", label: "Grupla", code: "KeyG", meta: true },
  // ⌘[ / ⌘] stay the app's back / forward (back to the board): the stacking keys take ⌥.
  {
    command: "layer.forward",
    keys: "⌥⌘]",
    label: "Öne getir",
    code: "BracketRight",
    meta: true,
    alt: true,
  },
  {
    command: "layer.backward",
    keys: "⌥⌘[",
    label: "Arkaya gönder",
    code: "BracketLeft",
    meta: true,
    alt: true,
  },
  { command: "slide.prev", keys: "←", label: "Önceki kare", code: "ArrowLeft" },
  { command: "slide.next", keys: "→", label: "Sonraki kare", code: "ArrowRight" },
  { command: "zoom.fit", keys: "⇧1", label: "Tüm kareleri sığdır", code: "Digit1", shift: true },
  {
    command: "zoom.selection",
    keys: "⇧2",
    label: "Seçime yakınlaştır",
    code: "Digit2",
    shift: true,
  },
  { command: "zoom.100", keys: "⌘0", label: "%100", code: "Digit0", meta: true },
  { command: "zoom.in", keys: "⌘+", label: "Yakınlaştır", key: "+", meta: true },
  { command: "zoom.out", keys: "⌘−", label: "Uzaklaştır", key: "-", meta: true },
  { command: "view.safeArea", keys: "⌘'", label: "Güvenli alanı aç / kapat", key: "'", meta: true },
  { command: "view.rulers", keys: "⇧R", label: "Cetveller", code: "KeyR", shift: true },
  { command: "view.snapping", keys: "⌘;", label: "Yapışmayı aç / kapat", key: ";", meta: true },
  {
    command: "versions.open",
    keys: "⇧⌘V",
    label: "Sürümler",
    code: "KeyV",
    meta: true,
    shift: true,
  },
  { command: "versions.save", keys: "⌘S", label: "Sürüm kaydet", code: "KeyS", meta: true },
  { command: "preview", keys: "⌘P", label: "Önizle", code: "KeyP", meta: true },
  { command: "schedule", keys: "⇧⌘↩", label: "Zamanla", code: "Enter", meta: true, shift: true },
  { command: "approve", keys: "⌘↩", label: "Onayla", code: "Enter", meta: true },
  { command: "caption.tab", keys: "⌘E", label: "Tasarım / Açıklama", code: "KeyE", meta: true },
  { command: "select.all", keys: "⌘A", label: "Tümünü seç", code: "KeyA", meta: true },
  { command: "text.edit", keys: "↩", label: "Metni düzenle", code: "Enter" },
  { command: "escape", keys: "Esc", label: "Seçimi bırak / menüyü kapat", code: "Escape" },
];

export interface KeyLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** ⌘ on a Mac, Ctrl elsewhere. */
export function primary(e: Pick<KeyLike, "metaKey" | "ctrlKey">, mac = true): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/** The shortcut a key press is, or null. */
export function matchShortcut(e: KeyLike, mac = true): Shortcut | null {
  const meta = primary(e, mac);
  for (const s of SHORTCUTS) {
    if (Boolean(s.meta) !== meta) continue;
    if (Boolean(s.alt) !== e.altKey) continue;
    // Shift is part of punctuation keys ("+" is ⇧= on many layouts): only checked for codes.
    if (s.code && Boolean(s.shift) !== e.shiftKey) continue;
    if (s.code && (e.code === s.code || (s.alsoCode && e.code === s.alsoCode))) return s;
    if (
      s.key &&
      (e.key === s.key || (s.key === "+" && e.key === "=") || (s.key === "-" && e.key === "_"))
    )
      return s;
  }
  return null;
}

export function shortcutKeys(command: ShortcutCommand): string | undefined {
  return SHORTCUTS.find((s) => s.command === command)?.keys;
}
