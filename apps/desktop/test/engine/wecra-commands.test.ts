// What of Wecra's editor the post editor has (E16): Studio's allowlist takes every other command
// out of Wecra's registry — so their keys do nothing and no menu or panel button shows them —
// and Wecra's own UI lives with the smaller registry (the embedding patches).
import "../../src/renderer/features/post-editor/wecra/embed.ts";
import { describe, expect, it } from "vitest";
import type { MenuEntry } from "@/ds";
import {
  COMMAND_BY_ID,
  COMMANDS,
  command,
  commandForKey,
  runEditorCommand,
} from "@/editor/commands";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { attachKeyboard } from "@/editor/keyboard";
import { canvasMenu } from "@/editor/menus";
import { modifiersOf } from "@/engine/CanvasController";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BundleImages } from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import {
  POST_EDITOR_COMMANDS,
  postEditorMenu,
  postEditorViewMenu,
  restrictWecraCommands,
} from "../../src/renderer/features/post-editor/wecra/commands.ts";
import {
  SAFE_AREAS_COMMAND,
  safeAreasOn,
} from "../../src/renderer/features/post-editor/wecra/safe-areas.ts";

restrictWecraCommands();

/** Commands a social post editor must not have (E16), by Wecra's ids. */
const HIDDEN = [
  "object.create-component",
  "object.create-multiple-components",
  "object.combine-as-variants",
  "object.detach-instance",
  "object.convert-to-slot",
  "file.publish-library",
  "file.libraries",
  "file.create-branch",
  "file.see-all-branches",
  "file.review-and-merge",
  "file.save-version",
  "file.version-history",
  "view.dev-mode",
  "view.switch-to-motion",
  "view.switch-to-draw",
  "tool.comment",
  "view.comments",
  "plugins.run-last",
  "plugins.manage",
  "widgets.manage",
  "view.prototype-panel",
  "view.prototyping-info",
  "view.present",
  "view.preview",
  "file.export-frames-to-pdf",
  "file.share-preview",
  "view.local-variables",
  "view.assets",
  "motion.play-pause",
  "social.toggle-safe-areas",
  "object.wrap-in-section",
  "view.toggle-ui",
  "tool.actions",
  "canvas.cursor-chat",
  "help.shortcuts",
];

const press = (code: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  // jsdom is no Mac: Wecra's "primary" modifier is Ctrl here.
  ctrlKey: !!mods.mod,
  metaKey: false,
});

async function editor() {
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), {
    sessionID: 7,
    images: new BundleImages(),
  });
  const engine = await Engine.create(null, { sessionID: 7 });
  expect(engine.load(await source.load())).toBe(0);
  return new EditorController(engine, new EngineStore(engine), source);
}

const ids = (entries: readonly MenuEntry[]): string[] =>
  entries.flatMap((e) =>
    e === "-" || "header" in e ? [] : [e.id, ...(e.items ? ids(e.items) : [])],
  );

describe("Wecra's commands in the post editor (E16)", () => {
  it("keeps only the allowlist (and Studio's own) in Wecra's registry", () => {
    for (const id of HIDDEN) expect(COMMAND_BY_ID.has(id), id).toBe(false);
    for (const c of COMMANDS)
      expect(POST_EDITOR_COMMANDS.has(c.id) || c.id === SAFE_AREAS_COMMAND, c.id).toBe(true);
    expect(COMMANDS.length).toBe(COMMAND_BY_ID.size);
    // What a post editor needs stays.
    for (const id of [
      "edit.undo",
      "edit.copy",
      "object.group",
      "arrange.align-left",
      "vector.union",
      "text.bold",
      "tool.rectangle",
      "tool.text",
      "view.zoom-fit",
      "file.export",
    ])
      expect(COMMAND_BY_ID.has(id), id).toBe(true);
  });

  it("gives the left-out commands' keys nothing to run", () => {
    const hidden: [string, ReturnType<typeof press>][] = [
      ["dev mode ⇧D", press("KeyD", { shift: true })],
      ["comment C", press("KeyC")],
      ["create component ⌥⌘K", press("KeyK", { mod: true, alt: true })],
      ["save version ⌥⌘S", press("KeyS", { mod: true, alt: true })],
      ["run last plugin ⌥⌘P", press("KeyP", { mod: true, alt: true })],
      ["prototyping info ⇧E", press("KeyE", { shift: true })],
      ["comments ⇧C", press("KeyC", { shift: true })],
      ["annotation Y", press("KeyY")],
      ["wrap in section ⌘S", press("KeyS", { mod: true })],
      ["toggle UI ⌘\\", press("Backslash", { mod: true })],
      ["preview ⇧Space", press("Space", { shift: true })],
      ["multi-edit variants Q", press("KeyQ")],
      ["component search ⇧I", press("KeyI", { shift: true })],
      ["actions ⌘K", press("KeyK", { mod: true })],
      ["cursor chat /", press("Slash")],
      ["section ⇧S", press("KeyS", { shift: true })],
      ["slice S", press("KeyS")],
      ["measurement ⇧M", press("KeyM", { shift: true })],
    ];
    for (const [name, e] of hidden) expect(commandForKey(e)?.id ?? null, name).toBe(null);
    // Kept keys still run their commands.
    expect(commandForKey(press("KeyR"))?.id).toBe("tool.rectangle");
    expect(commandForKey(press("KeyT"))?.id).toBe("tool.text");
    expect(commandForKey(press("KeyG", { mod: true }))?.id).toBe("object.group");
    expect(commandForKey(press("KeyZ", { mod: true }))?.id).toBe("edit.undo");
  });

  it("does nothing on the left-out keys with Wecra's keyboard attached", async () => {
    const ed = await editor();
    // The canvas in the editor's place (keys elsewhere are Studio's: embed.ts ownsEvent).
    const region = document.createElement("div");
    region.setAttribute("data-wecra-region", "canvas");
    const canvas = document.createElement("canvas");
    region.appendChild(canvas);
    document.body.appendChild(region);
    const off = attachKeyboard(ed, canvas);
    try {
      const key = (code: string, init: KeyboardEventInit = {}) =>
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
      // The engine doesn't take these keys itself (a canvas key goes to it first): only the
      // registry would run them.
      for (const [code, shiftKey] of [
        ["KeyC", false],
        ["KeyY", false],
        ["KeyD", true],
        ["KeyS", false],
      ] as const) {
        const e = new KeyboardEvent("keydown", { code, shiftKey });
        expect(ed.engineKey("down", e, modifiersOf(e)), code).toBe(false);
      }
      const before = ed.store.tool;
      key("KeyC"); // Comment
      key("KeyY"); // Annotation
      key("KeyD", { shiftKey: true }); // Dev Mode
      key("KeyS"); // Slice
      expect(ed.store.tool).toBe(before);
      expect((ed.ui.get() as { mode?: string }).mode ?? "design").toBe("design");
      key("KeyR"); // Rectangle: kept
      expect(ed.store.tool).not.toBe(before);
    } finally {
      off();
      region.remove();
    }
  });

  it("refuses to run a left-out command; a panel asking for one gets a disabled stand-in", async () => {
    const ed = await editor();
    expect(runEditorCommand(ed, "view.dev-mode")).toBe(false);
    expect(runEditorCommand(ed, "file.save-version")).toBe(false);
    const stub = command("object.create-component");
    expect(stub.enabled?.(ed)).toBe(false);
  });

  it("leaves left-out rows out of the canvas menu and the view menu, Güvenli alanlar in", async () => {
    const ed = await editor();
    const empty = ids(canvasMenu(ed, []));
    expect(empty).not.toContain("view.comments");
    expect(empty).not.toContain("tool.actions");
    expect(empty).not.toContain("canvas.cursor-chat");
    expect(empty.some((id) => id.startsWith("add-button:"))).toBe(false);
    // A shape selected: Wecra's full menu filtered.
    const env = { ed, write: (_l: string, fn: () => void) => ed.engine.ignoringUndo(fn) };
    const { runTool } = await import("@/editor/agents/mcpTools");
    await runTool(env as never, "create_nodes", {
      parentId: ed.store.page,
      nodes: [{ type: "RECTANGLE", x: 0, y: 0, width: 50, height: 50 }],
    });
    const page = ed.engine.readNode(ed.store.page, { childIds: true }) as { childIds?: string[] };
    ed.engine.setSelection([page.childIds?.[0] as string]);
    const menu = canvasMenu(ed, [{ id: page.childIds?.[0] as string, name: "Rectangle" }]);
    const all = ids(menu);
    for (const id of all)
      if (!id.startsWith("submenu:") && !id.startsWith("select-layer:"))
        expect(COMMAND_BY_ID.has(id), id).toBe(true);
    for (const gone of [
      "object.create-component",
      "canvas.send-to-make",
      "canvas.find-similar",
      "submenu:widgets",
      "submenu:add-motion",
      "submenu:buttons",
    ])
      expect(all, gone).not.toContain(gone);
    expect(all).toContain("edit.copy");
    expect(all).toContain("object.group");
    // The view (zoom) menu: Wecra's view rows the post editor has, then Güvenli alanlar.
    const view = postEditorViewMenu(
      [
        { id: "view.zoom-in", label: "Zoom in" },
        { id: "view.comments", label: "Comments", disabled: true },
        { id: "view.multiplayer-cursors", label: "Cursors", disabled: true },
        "-",
        {
          id: "zoom.pixel-preview",
          label: "Pixel preview",
          items: [
            { id: "zoom.pixel-preview-0", label: "Disabled" },
            { id: "zoom.pixel-preview-1", label: "1x" },
          ],
        },
        { id: "zoom.property-labels", label: "Property labels" },
      ],
      ed,
    );
    expect(ids(view)).toEqual([
      "view.zoom-in",
      "zoom.pixel-preview",
      "zoom.pixel-preview-0",
      "zoom.pixel-preview-1",
      SAFE_AREAS_COMMAND,
    ]);
    expect(safeAreasOn(ed)).toBe(false);
    expect(runEditorCommand(ed, SAFE_AREAS_COMMAND)).toBe(true);
    expect(safeAreasOn(ed)).toBe(true);
    expect(postEditorMenu(["-", { id: "plugin:x", label: "Plugin" }, "-"])).toEqual([]);
  });
});
