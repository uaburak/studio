// What of Wecra's editor a post editor has (E16): Studio decides which of Wecra's commands exist.
// Wecra's registry (`COMMANDS`, `COMMAND_BY_ID`) is the one source of its main menu, canvas
// menu, keyboard shortcuts, Actions palette and panel buttons; `restrictWecraCommands` keeps
// only the commands below (an allowlist: a command a newer Wecra adds stays out until it is
// listed here) and adds Studio's own (Güvenli alanlar). So a component, branch, version history,
// Dev Mode, Motion / Draw, comment, plugin, prototype or library command has no key, no menu
// row and no button in the post editor — the code is still there, nothing reaches it.
//
// Wecra's UI then lives with the smaller registry through the embedding patches
// (scripts/vendor-wecra.mjs, "command-stub" … "design-panel"): a panel asking for a command left
// out gets a disabled stand-in; the canvas menu, the zoom (view) menu, the Design panel header's
// buttons and the toolbar's tool menus go through the filters here.
//
// Kept: selection, tools for shapes, frames, pen / pencil, text and images; transform, align,
// distribute, arrange, group, frame, mask, boolean groups and Wecra's other vector operations;
// text formatting; layers (rename, show / hide, lock, order); zoom, rulers, outlines, guides;
// undo / redo, the clipboard (Copy as PNG / SVG / text included) and Wecra's Export of the
// selection (⇧⌘E and the Design panel's Export section: Studio has no export of its own yet).
import type { MenuEntry, MenuItem } from "@/ds";
import { COMMAND_BY_ID, COMMANDS, type EditorCommand } from "@/editor/commands";
import type { EditorController } from "@/editor/controller";
import { SAFE_AREAS_COMMAND, safeAreasOn, toggleSafeAreas } from "./safe-areas.ts";

const TOOLS = [
  "tool.move",
  "tool.hand",
  "tool.scale",
  "tool.frame",
  "tool.rectangle",
  "tool.line",
  "tool.arrow",
  "tool.ellipse",
  "tool.polygon",
  "tool.star",
  "tool.image",
  "tool.pen",
  "tool.pencil",
  "tool.text",
  "tool.text-on-path",
];

const EDIT = [
  "edit.undo",
  "edit.redo",
  "edit.copy",
  "edit.cut",
  "edit.paste",
  "edit.paste-over-selection",
  "edit.paste-here",
  "edit.paste-to-replace",
  "edit.copy-as-png",
  "edit.copy-as-svg",
  "edit.copy-as-text",
  "edit.duplicate",
  "edit.delete",
  "edit.copy-properties",
  "edit.paste-properties",
  "edit.pick-color",
  "edit.select-all",
  "edit.select-matching",
  "edit.select-none",
  "edit.select-inverse",
  "edit.select-same-fill",
  "edit.select-same-stroke",
  "edit.select-same-effect",
  "edit.select-same-text",
  "edit.select-same-font",
];

const VIEW = [
  "view.collapse-layers",
  "view.rulers",
  "view.pixel-grid",
  "view.snap-pixel-grid",
  "view.layout-guides",
  "view.outlines",
  "view.outline-hidden-layers",
  "view.outline-object-bounds",
  "view.pixel-preview",
  "view.mask-outlines",
  "view.frame-outlines",
  "view.zoom-in",
  "view.zoom-out",
  "view.zoom-100",
  "view.zoom-fit",
  "view.zoom-selection",
  "view.zoom-50",
  "view.zoom-200",
  // N / ⇧N, Home / End: from slide to slide.
  "view.zoom-previous-frame",
  "view.zoom-next-frame",
  "view.find-previous-frame",
  "view.find-next-frame",
  "prefs.snap-to-geometry",
  "prefs.snap-to-objects",
  "canvas.remove-guide",
  "canvas.remove-horizontal-guides",
  "canvas.remove-vertical-guides",
  "canvas.hide-rulers",
];

const OBJECT = [
  "object.group",
  "object.ungroup",
  "object.frame-selection",
  "object.convert-to-frame",
  "object.add-auto-layout",
  "object.remove-auto-layout",
  "object.suggest-auto-layout",
  "object.remove-all-auto-layout",
  "object.add-layout-horizontal",
  "object.add-layout-vertical",
  "object.add-layout-grid",
  "object.hide-other-layers",
  "object.remove-fill",
  "object.remove-stroke",
  "object.swap-fill-stroke",
  "object.use-as-mask",
  "object.bring-to-front",
  "object.bring-forward",
  "object.send-backward",
  "object.send-to-back",
  "object.flip-horizontal",
  "object.flip-vertical",
  "object.rotate-180",
  "object.rotate-90-left",
  "object.rotate-90-right",
  "object.rotation-origin",
  "object.toggle-visible",
  "object.toggle-lock",
  "object.rename",
];

const ARRANGE = [
  "arrange.round-to-pixel",
  "arrange.align-left",
  "arrange.align-horizontal-center",
  "arrange.align-right",
  "arrange.align-top",
  "arrange.align-vertical-center",
  "arrange.align-bottom",
  "arrange.tidy-up",
  "arrange.pack-horizontal",
  "arrange.pack-vertical",
  "arrange.distribute-horizontal",
  "arrange.distribute-vertical",
  "arrange.distribute-left",
  "arrange.distribute-horizontal-centers",
  "arrange.distribute-right",
  "arrange.distribute-top",
  "arrange.distribute-vertical-centers",
  "arrange.distribute-bottom",
];

const VECTOR = [
  "vector.flatten",
  "vector.outline-stroke",
  "vector.union",
  "vector.subtract",
  "vector.intersect",
  "vector.exclude",
  "vector.update-boolean",
  "vector.pathfinder-divide",
  "vector.pathfinder-trim",
  "vector.pathfinder-merge",
  "vector.pathfinder-crop",
  "vector.pathfinder-outline",
  "vector.pathfinder-minus-back",
  "vector.pathfinder-options",
  "vector.join",
  "vector.smooth-join",
  "vector.delete-heal",
  "vector.split",
  "vector.simplify",
  "vector.offset",
];

const TEXT = [
  "text.bold",
  "text.italic",
  "text.underline",
  "text.strikethrough",
  "text.bulleted-list",
  "text.numbered-list",
  "text.align-left",
  "text.align-center",
  "text.align-right",
  "text.align-justified",
  "text.font-size-up",
  "text.font-size-down",
  "text.font-weight-up",
  "text.font-weight-down",
  "text.line-height-up",
  "text.line-height-down",
  "text.letter-spacing-up",
  "text.letter-spacing-down",
  "text.case-original",
  "text.case-upper",
  "text.case-lower",
  "text.case-title",
  "text.case-small-caps",
  "text.case-forced-small-caps",
  "text.direction-auto",
  "text.direction-ltr",
  "text.direction-rtl",
  "text.flip-path",
];

/** Placing pictures and Wecra's Export of the selection (Studio has no export of its own yet). */
const FILE = ["file.place-image", "file.export"];

/** Wecra's commands the post editor has (every other one is taken out of Wecra's registry). */
export const POST_EDITOR_COMMANDS: ReadonlySet<string> = new Set([
  ...TOOLS,
  ...EDIT,
  ...VIEW,
  ...OBJECT,
  ...ARRANGE,
  ...VECTOR,
  ...TEXT,
  ...FILE,
]);

/** Studio's own commands in Wecra's registry (its view menu runs them). */
const STUDIO_COMMANDS: EditorCommand[] = [
  {
    id: SAFE_AREAS_COMMAND,
    label: "Güvenli alanlar",
    run: (ed) => toggleSafeAreas(ed),
    checked: (ed) => safeAreasOn(ed),
  },
];

/** The toolbar's tools the post editor has (its tool menus leave the others out). */
const TOOLBAR_TOOLS = new Set(TOOLS.map((id) => id.slice("tool.".length)));

/** The Design panel header's buttons kept (no component, slot, dev status, link, text variable). */
const HEADER_ACTIONS = new Set(["mask", "boolean", "edit", "matching", "more"]);

/**
 * Menu items that are not commands but are the post editor's: Select layer ▸ (the layers under the
 * pointer) and the zoom menu's Pixel preview ▸ Disabled / 1x / 2x.
 */
const DYNAMIC = ["select-layer:", "zoom.pixel-preview-"];

const allowedItem = (id: string) =>
  COMMAND_BY_ID.has(id) || DYNAMIC.some((prefix) => id.startsWith(prefix));

const isItem = (e: MenuEntry): e is MenuItem => e !== "-" && !("header" in e);

/**
 * A menu with only what the post editor has: commands it kept, Select layer ▸, and submenus with
 * something left in them — a row of a command left out (Wecra's menus show some greyed: Send to
 * Figma Make, Find similar designs, Widgets ▸, Add motion ▸) is gone; the lines are tidied.
 */
export function postEditorMenu(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e === "-") {
      if (out.length && out[out.length - 1] !== "-") out.push(e);
      continue;
    }
    if (!isItem(e)) continue;
    if (e.items) {
      const items = postEditorMenu(e.items);
      if (items.some((i) => i !== "-")) out.push({ ...e, items });
      continue;
    }
    if (allowedItem(e.id)) out.push(e);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/**
 * The zoom menu as Studio's view menu: Wecra's zoom, pixel preview, grids, rulers and outlines
 * (no multiplayer cursors, comments, annotations or property labels), then Güvenli alanlar.
 */
export function postEditorViewMenu(
  entries: readonly MenuEntry[],
  ed: EditorController,
): MenuEntry[] {
  const kept = postEditorMenu(entries);
  const command = COMMAND_BY_ID.get(SAFE_AREAS_COMMAND);
  if (!command) return kept;
  return [...kept, "-", { id: command.id, label: command.label, checked: !!command.checked?.(ed) }];
}

let restricted = false;

/**
 * Takes every command the post editor doesn't have out of Wecra's registry (its keys go with
 * it), adds Studio's, and hands Wecra's UI the filters above (embed.ts's `__wecraEmbed`).
 * Once per page; Wecra's registry is a module's (the same for every open editor).
 */
export function restrictWecraCommands(): void {
  const embed = (globalThis as { __wecraEmbed?: Record<string, unknown> }).__wecraEmbed;
  if (embed) {
    Object.assign(embed, {
      canvasMenu: (entries: MenuEntry[]) => postEditorMenu(entries),
      viewMenu: (entries: MenuEntry[], ed: EditorController) => postEditorViewMenu(entries, ed),
      headerAction: (action: string) => HEADER_ACTIONS.has(action),
      tool: (id: string) => TOOLBAR_TOOLS.has(id),
    });
  }
  if (restricted) return;
  restricted = true;
  for (let i = COMMANDS.length - 1; i >= 0; i--) {
    const c = COMMANDS[i];
    if (c && !POST_EDITOR_COMMANDS.has(c.id)) {
      COMMANDS.splice(i, 1);
      COMMAND_BY_ID.delete(c.id);
    }
  }
  for (const c of STUDIO_COMMANDS) {
    COMMANDS.push(c);
    COMMAND_BY_ID.set(c.id, c);
  }
}
