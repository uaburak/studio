// The one floating object at the bottom of the canvas (Wecra's bottom toolbar: tools, a
// full-height line, the mode switch at the right). Its mode switch is Sohbet / Düzenle:
// Düzenle shows the edit tools (select ▾, text, shape, image, undo / redo, safe area, view ▾,
// zoom ▾), Sohbet turns the same object into the post's message box — the capsule morphs
// (width, height and content, `motion` layout animation) and back.
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import {
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import {
  IconChat,
  IconClose,
  IconEye,
  IconPencil,
  IconRedo,
  IconUndo,
} from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import { Popover } from "../../../components/ui/popover.tsx";
import type { CanvasTool } from "../canvas/controller.ts";
import type { EditorSession } from "../session.ts";
import type { WorkspaceMode } from "../workspace-store.ts";
import { useCanvasView } from "./canvas-view.tsx";
import {
  IconArrowUp,
  IconAt,
  IconChevronDown,
  IconHand,
  IconImagePlus,
  IconPhoneFrame,
  IconPointer,
  IconScale,
  IconShape,
  IconText,
} from "./glyphs.tsx";
import { layerTitle } from "./layers-dock.tsx";

const SPRING = { type: "spring", duration: 0.42, bounce: 0.16 } as const;

export const MODE_LABEL: Record<WorkspaceMode, string> = { chat: "Sohbet", edit: "Düzenle" };

/** The morphing capsule: the mode's content, a line, the mode switch. */
export function ModeDock({
  mode,
  onMode,
  edit,
  chat,
}: {
  mode: WorkspaceMode;
  onMode(mode: WorkspaceMode): void;
  edit: ReactNode;
  chat: ReactNode;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id="post-dock">
        <motion.div
          layout
          transition={SPRING}
          data-mode={mode}
          data-testid="mode-dock"
          style={{ borderRadius: 24 }}
          className="glass-composer pointer-events-auto relative flex max-w-full items-end gap-1.5 p-2"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={mode}
              layout="position"
              initial={{ opacity: 0, scale: 0.97, filter: "blur(3px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.97, filter: "blur(3px)" }}
              transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex min-w-0 items-end"
            >
              {mode === "edit" ? edit : chat}
            </motion.div>
          </AnimatePresence>
          <motion.span
            layout="position"
            transition={SPRING}
            aria-hidden="true"
            className="-my-2 w-px self-stretch bg-hairline"
          />
          <motion.div layout="position" transition={SPRING} className="flex">
            <ModeSwitch mode={mode} onMode={onMode} />
          </motion.div>
        </motion.div>
      </LayoutGroup>
    </MotionConfig>
  );
}

/** Sohbet · Düzenle (Wecra's mode switch: a track, the chosen one a raised thumb). */
export function ModeSwitch({
  mode,
  onMode,
}: {
  mode: WorkspaceMode;
  onMode(mode: WorkspaceMode): void;
}) {
  const options: { value: WorkspaceMode; icon: ReactNode; keys: string }[] = [
    { value: "chat", icon: <IconChat size={14} strokeWidth={1.6} />, keys: "⌘K" },
    { value: "edit", icon: <IconPencil size={14} strokeWidth={1.6} />, keys: "V" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Mod"
      className="no-drag flex h-8 items-center gap-0.5 rounded-full bg-field p-0.5"
    >
      {options.map((o) => {
        const selected = o.value === mode;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a two-way segmented switch, as SegmentedControl
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={`${MODE_LABEL[o.value]} (${o.keys})`}
            aria-label={MODE_LABEL[o.value]}
            onClick={() => onMode(o.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              onMode(mode === "chat" ? "edit" : "chat");
            }}
            className={cn(
              "relative flex h-7 items-center gap-1.5 rounded-full px-2 text-body transition-colors @[640px]:px-2.5",
              selected ? "text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {selected && (
              <motion.span
                layoutId="mode-thumb"
                transition={SPRING}
                className="absolute inset-0 rounded-full bg-popover shadow-sm"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {o.icon}
              {/* A narrow canvas keeps the icons (the name stays the radio's label). */}
              <span className="hidden @[640px]:inline">{MODE_LABEL[o.value]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- Düzenle: the tools -------------------------------------------------------------------------

const MOVE_TOOLS: { tool: CanvasTool; label: string; keys: string; icon: ReactNode }[] = [
  { tool: "MOVE", label: "Seç", keys: "V", icon: <IconPointer size={15} strokeWidth={1.6} /> },
  { tool: "HAND", label: "El", keys: "H", icon: <IconHand size={15} strokeWidth={1.6} /> },
  { tool: "SCALE", label: "Ölçekle", keys: "K", icon: <IconScale size={15} strokeWidth={1.6} /> },
];

/** An active tool is filled with the accent (Wecra / Figma); the rest are quiet. */
const TOOL_CLASS =
  "rounded-full data-[selected]:bg-accent data-[selected]:text-on-accent data-[selected]:hover:bg-accent-hover";

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-hairline" />;
}

export function EditTools({
  session,
  onPlaceImage,
  viewEntries,
}: {
  session: EditorSession;
  onPlaceImage(): void;
  /** The view menu's entries (focus, snapping, rulers, preview format). */
  viewEntries: () => MenuEntry[];
}) {
  const { canvas, canvasState: s, draft, draftState: d } = session;
  const view = useCanvasView(canvas);
  const engineReady = s.engine === "ready";
  // The move slot shows the last of its tools used (Wecra's slots).
  const [moveTool, setMoveTool] = useState<CanvasTool>("MOVE");
  const current = MOVE_TOOLS.find((t) => t.tool === s.tool);
  if (current && current.tool !== moveTool) setMoveTool(current.tool);
  const slot = MOVE_TOOLS.find((t) => t.tool === moveTool) ?? MOVE_TOOLS[0];
  const pick = (tool: CanvasTool) => {
    canvas.setTool(tool);
    canvas.focusCanvas();
  };
  const lastUndo = d.undo.at(-1);
  const lastRedo = d.redo.at(-1);
  const zoom = Math.round(view.camera.zoom * 100);

  return (
    <div role="toolbar" aria-label="Araçlar" className="flex h-8 items-center gap-0.5">
      {slot && (
        <IconButton
          size={32}
          icon={slot.icon}
          label={slot.label}
          shortcut={slot.keys}
          selected={MOVE_TOOLS.some((t) => t.tool === s.tool)}
          disabled={!engineReady}
          className={TOOL_CLASS}
          onClick={() => pick(slot.tool)}
        />
      )}
      <MenuButton
        label="Seçim araçları"
        placement="top-start"
        width={190}
        entries={MOVE_TOOLS.map((t) => ({
          id: t.tool,
          label: t.label,
          shortcut: t.keys,
          icon: t.icon,
          checked: s.tool === t.tool,
          disabled: !engineReady,
          onSelect: () => pick(t.tool),
        }))}
      >
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            aria-label="Seçim araçları"
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...aria}
            className={cn(
              "no-drag -ml-0.5 flex h-8 w-4 items-center justify-center rounded-full text-fg-3 hover:bg-control hover:text-fg",
              open && "bg-control text-fg",
            )}
          >
            <IconChevronDown size={11} />
          </button>
        )}
      </MenuButton>
      <IconButton
        size={32}
        icon={<IconText size={15} strokeWidth={1.6} />}
        label="Metin"
        shortcut="T"
        selected={s.tool === "TEXT"}
        className={TOOL_CLASS}
        onClick={() => pick("TEXT")}
      />
      <IconButton
        size={32}
        icon={<IconShape size={15} strokeWidth={1.6} />}
        label="Şekil"
        shortcut="R"
        selected={s.tool === "RECTANGLE"}
        disabled={!engineReady}
        className={TOOL_CLASS}
        onClick={() => pick("RECTANGLE")}
      />
      <IconButton
        size={32}
        icon={<IconImagePlus size={15} strokeWidth={1.6} />}
        label="Görsel yerleştir"
        shortcut="⇧⌘K"
        onClick={onPlaceImage}
      />
      <span className="hidden items-center gap-0.5 @[560px]:flex">
        <Divider />
        <IconButton
          size={32}
          icon={<IconUndo size={15} strokeWidth={1.6} />}
          label={lastUndo ? `Geri al: ${lastUndo.name}` : "Geri al"}
          shortcut="⌘Z"
          disabled={!lastUndo}
          onClick={() => draft.undo()}
        />
        <IconButton
          size={32}
          icon={<IconRedo size={15} strokeWidth={1.6} />}
          label={lastRedo ? `Yinele: ${lastRedo.name}` : "Yinele"}
          shortcut="⇧⌘Z"
          disabled={!lastRedo}
          onClick={() => draft.redo()}
        />
      </span>
      <Divider />
      <IconButton
        size={32}
        icon={<IconPhoneFrame size={15} strokeWidth={1.6} />}
        label="Güvenli alan"
        shortcut="⌘'"
        selected={s.safeArea}
        onClick={() => canvas.setSafeArea(!s.safeArea)}
      />
      <MenuButton label="Görünüm" placement="top-end" width={250} entries={viewEntries}>
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <IconButton
            ref={ref}
            size={32}
            icon={<IconEye size={15} strokeWidth={1.6} />}
            label="Görünüm"
            selected={open}
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...aria}
          />
        )}
      </MenuButton>
      <MenuButton
        label="Yakınlaştırma"
        placement="top-end"
        width={220}
        entries={[
          {
            id: "in",
            label: "Yakınlaştır",
            shortcut: "⌘+",
            onSelect: () => canvas.command("ZOOM_IN"),
          },
          {
            id: "out",
            label: "Uzaklaştır",
            shortcut: "⌘−",
            onSelect: () => canvas.command("ZOOM_OUT"),
          },
          { type: "separator" },
          {
            id: "fit",
            label: "Tüm kareleri sığdır",
            shortcut: "⇧1",
            onSelect: () => canvas.command("ZOOM_TO_FIT"),
          },
          {
            id: "selection",
            label: "Seçime yakınlaştır",
            shortcut: "⇧2",
            onSelect: () =>
              s.selection.length
                ? canvas.command("ZOOM_TO_SELECTION")
                : canvas.zoomToSlide(s.activeSlide),
          },
          {
            id: "100",
            label: "%100",
            shortcut: "⌘0",
            onSelect: () => canvas.command("ZOOM_TO_100"),
          },
        ]}
      >
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            aria-label={`Yakınlaştırma %${zoom}`}
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...aria}
            className={cn(
              "no-drag flex h-8 items-center gap-0.5 rounded-full pr-1.5 pl-2.5 text-footnote text-fg tabular-nums hover:bg-control",
              open && "bg-control",
            )}
          >
            %{zoom}
            <IconChevronDown size={11} className="text-fg-3" />
          </button>
        )}
      </MenuButton>
    </div>
  );
}

// --- Sohbet: the message box --------------------------------------------------------------------

export interface ChatInputHandle {
  /** Focus the box; `prefill` replaces the text, `scope` replaces the picked layers. */
  focus(prefill?: string, scope?: readonly string[]): void;
}

export const ChatInput = forwardRef<
  ChatInputHandle,
  {
    session: EditorSession;
    working: boolean;
    disabled: string | null;
    placeholder?: string;
    onSend(text: string, scope: readonly string[]): Promise<boolean>;
    onStop(): void;
  }
>(function ChatInput({ session, working, disabled, placeholder, onSend, onStop }, ref) {
  const { canvas, canvasState: s } = session;
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const scope = picked ?? s.selection;

  useImperativeHandle(ref, () => ({
    focus(prefill, scopeKeys) {
      if (prefill !== undefined) setText(prefill);
      if (scopeKeys) setPicked(scopeKeys.length ? [...scopeKeys] : null);
      requestAnimationFrame(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }));

  // Grows with the text (up to six lines, then scrolls).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    // Empty: one line (a wrapping placeholder does not grow the box).
    el.style.height = "0px";
    el.style.height = text ? `${Math.min(el.scrollHeight, 132)}px` : "22px";
  }, [text]);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLocaleLowerCase("tr-TR");
    const out: { key: string; label: string; detail: string }[] = [];
    canvas.editorSlides.forEach((slide) => {
      for (const layer of slide.layers) {
        const label = layerTitle(layer);
        if (q && !label.toLocaleLowerCase("tr-TR").includes(q) && !layer.id.includes(q)) continue;
        out.push({ key: layer.key, label, detail: `Kare ${slide.index + 1}` });
      }
    });
    return out.slice(0, 8);
  }, [mention, canvas.editorSlides]);

  const pick = (key: string) => {
    if (!mention) return;
    setPicked([...new Set([...(picked ?? []), key])]);
    setText(text.slice(0, mention.start) + text.slice(mention.start + 1 + mention.query.length));
    setMention(null);
    input.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    const ok = await onSend(t, scope).finally(() => setSending(false));
    if (ok) {
      setText("");
      setPicked(null);
    }
  };

  const chips = scope.map((key) => {
    const layer = canvas.layer(key);
    return { key, label: layer ? layerTitle(layer) : key };
  });
  const canSend = !!text.trim() && !disabled && !sending;

  return (
    <div className="flex w-[min(520px,calc(100cqw-130px))] min-w-[200px] flex-col gap-1 @[640px]:w-[min(520px,calc(100cqw-250px))]">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-1 pt-0.5">
          {chips.slice(0, 5).map((c) => (
            <span
              key={c.key}
              className="inline-flex h-6 max-w-[180px] items-center gap-0.5 rounded-full bg-accent-subtle pr-0.5 pl-2 text-footnote text-accent-text"
            >
              <span className="truncate">@{c.label}</span>
              <button
                type="button"
                aria-label={`${c.label} kapsamdan çıkar`}
                onClick={() =>
                  picked
                    ? setPicked(picked.filter((k) => k !== c.key))
                    : canvas.selectLayers(s.selection.filter((k) => k !== c.key))
                }
                className="flex size-5 items-center justify-center rounded-full hover:bg-accent/20"
              >
                <IconClose size={10} />
              </button>
            </span>
          ))}
          {chips.length > 5 && <span className="text-footnote text-fg-3">+{chips.length - 5}</span>}
          {!picked && <span className="pl-1 text-caption text-fg-3">seçim</span>}
        </div>
      )}
      <div className="flex items-end gap-1">
        <IconButton
          size={32}
          icon={<IconAt size={15} strokeWidth={1.6} />}
          label="Katman seç (@)"
          onClick={() => {
            const at = text.length;
            setText(`${text}@`);
            setMention({ query: "", start: at });
            input.current?.focus();
          }}
        />
        <textarea
          ref={input}
          rows={1}
          aria-label="Post hakkında yaz"
          placeholder={
            disabled ??
            placeholder ??
            (working ? "↩ sıraya al · yanıt sürüyor" : "Bu post için ne yapayım? @ ile katman seç")
          }
          disabled={!!disabled}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            const caret = e.target.selectionStart ?? v.length;
            const m = /@([^\s@]*)$/.exec(v.slice(0, caret));
            setMention(m ? { query: m[1] ?? "", start: caret - (m[0]?.length ?? 1) } : null);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (mention && options.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive(
                  (a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const o = options[active];
                if (o) pick(o.key);
                return;
              }
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              if (mention) setMention(null);
              else input.current?.blur();
              return;
            }
            if (e.key === "Backspace" && text === "" && picked?.length) {
              setPicked(picked.slice(0, -1));
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="selectable my-[5px] max-h-[132px] min-h-[22px] min-w-0 flex-1 resize-none bg-transparent px-1 text-body leading-[22px] text-fg outline-none placeholder:text-fg-3"
        />
        {working && !text.trim() ? (
          <button
            type="button"
            aria-label="Durdur"
            title="Durdur"
            onClick={onStop}
            className="no-drag flex size-8 shrink-0 items-center justify-center rounded-full bg-control-hover text-fg transition-colors hover:bg-control-pressed"
          >
            <span className="size-2.5 rounded-[2px] bg-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={working ? "Sıraya al" : "Gönder"}
            title={working ? "Sıraya al (↩)" : "Gönder (↩)"}
            disabled={!canSend}
            onClick={() => void send()}
            className={cn(
              "no-drag flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150",
              canSend
                ? "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed"
                : "bg-control text-fg-3",
            )}
          >
            <IconArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      <Popover
        anchor={input.current}
        open={!!mention && options.length > 0}
        onClose={() => setMention(null)}
        placement="top-start"
        label="Katmanlar"
      >
        <div role="listbox" aria-label="Katman seç" className="flex w-[280px] flex-col p-1">
          {options.map((o, i) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.key);
              }}
              className={cn(
                "flex h-8 items-center gap-2 rounded-full px-2.5 text-left text-body",
                i === active ? "bg-control" : "hover:bg-control",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-fg">@{o.label}</span>
              <span className="shrink-0 text-footnote text-fg-3">{o.detail}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
});
