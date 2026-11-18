// The bottom of the canvas: the tools (select, hand, scale, text, shape, image, AI) and the
// "Neyi değiştireyim?" bar — `@` picks layers (or a slide) as the scope; the selection is the
// scope when nothing is picked. Sending saves the draft first, then asks for an AI revision.
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn, IconButton, Spinner } from "../../../components/ui/controls.tsx";
import { IconClose } from "../../../components/ui/icons.tsx";
import { Popover } from "../../../components/ui/popover.tsx";
import type { CanvasTool } from "../canvas/controller.ts";
import type { EditorSession } from "../session.ts";
import {
  IconArrowUp,
  IconAt,
  IconHand,
  IconImagePlus,
  IconPointer,
  IconScale,
  IconShape,
  IconSparkles,
  IconText,
} from "./glyphs.tsx";
import { layerTitle } from "./left-panel.tsx";

export interface PromptBarHandle {
  focus(prefill?: string, scope?: readonly string[]): void;
}

const TOOLS: { tool: CanvasTool; label: string; keys: string; icon: React.ReactNode }[] = [
  { tool: "MOVE", label: "Seç", keys: "V", icon: <IconPointer size={15} strokeWidth={1.6} /> },
  { tool: "HAND", label: "El", keys: "H", icon: <IconHand size={15} strokeWidth={1.6} /> },
  { tool: "SCALE", label: "Ölçekle", keys: "K", icon: <IconScale size={15} strokeWidth={1.6} /> },
  { tool: "TEXT", label: "Metin", keys: "T", icon: <IconText size={15} strokeWidth={1.6} /> },
  { tool: "RECTANGLE", label: "Şekil", keys: "R", icon: <IconShape size={15} strokeWidth={1.6} /> },
];

export function ToolsPill({
  session,
  onPlaceImage,
  onAi,
}: {
  session: EditorSession;
  onPlaceImage(): void;
  onAi(): void;
}) {
  const { canvas, canvasState: s } = session;
  return (
    <div
      className="glass-composer flex h-11 items-center gap-0.5 rounded-full px-1.5"
      role="toolbar"
      aria-label="Araçlar"
    >
      {TOOLS.map((t) => (
        <IconButton
          key={t.tool}
          size={32}
          icon={t.icon}
          label={t.label}
          shortcut={t.keys}
          selected={s.tool === t.tool}
          disabled={s.engine !== "ready" && t.tool !== "TEXT"}
          onClick={() => {
            canvas.setTool(t.tool);
            canvas.focusCanvas();
          }}
        />
      ))}
      <IconButton
        size={32}
        icon={<IconImagePlus size={15} strokeWidth={1.6} />}
        label="Görsel yerleştir"
        shortcut="⇧⌘K"
        onClick={onPlaceImage}
      />
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      <IconButton
        size={32}
        icon={<IconSparkles size={15} strokeWidth={1.6} />}
        label="AI komut çubuğu"
        shortcut="⌘K"
        onClick={onAi}
      />
    </div>
  );
}

export const PromptBar = forwardRef<
  PromptBarHandle,
  {
    session: EditorSession;
    busy: { label: string; cancel?: () => void } | null;
    disabled: string | null;
    onSend(text: string, scope: readonly string[]): Promise<boolean>;
  }
>(function PromptBar({ session, busy, disabled, onSend }, ref) {
  const { canvas, canvasState: s } = session;
  const input = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const scope = picked ?? s.selection;

  useImperativeHandle(ref, () => ({
    focus(prefill, scopeKeys) {
      if (prefill !== undefined) setText(prefill);
      if (scopeKeys) setPicked(scopeKeys.length ? [...scopeKeys] : null);
      requestAnimationFrame(() => {
        input.current?.focus();
        const len = input.current?.value.length ?? 0;
        input.current?.setSelectionRange(len, len);
      });
    },
  }));

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
    const next = [...new Set([...(picked ?? []), key])];
    setPicked(next);
    setText(text.slice(0, mention.start) + text.slice(mention.start + 1 + mention.query.length));
    setMention(null);
    input.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await onSend(t, scope);
    if (ok) {
      setText("");
      setPicked(null);
    }
  };

  const chips = scope.map((key) => {
    const layer = canvas.layer(key);
    return { key, label: layer ? layerTitle(layer) : key };
  });

  return (
    <div className="flex w-[520px] max-w-[60vw] flex-col items-stretch gap-1.5">
      {chips.length > 0 && !busy && (
        <div className="glass mx-auto flex max-w-full items-center gap-1 overflow-hidden rounded-full py-1 pr-1 pl-3 text-footnote text-fg-2">
          <span className="shrink-0">Kapsam</span>
          {chips.slice(0, 4).map((c) => (
            <span
              key={c.key}
              className="inline-flex h-5 max-w-[140px] items-center gap-0.5 rounded-full bg-accent-subtle pr-0.5 pl-1.5 text-accent-text"
            >
              <span className="truncate">@{c.label}</span>
              {picked && (
                <button
                  type="button"
                  aria-label={`${c.label} kapsamdan çıkar`}
                  onClick={() => setPicked(picked.filter((k) => k !== c.key))}
                  className="flex size-4 items-center justify-center rounded-full hover:bg-accent/20"
                >
                  <IconClose size={9} />
                </button>
              )}
            </span>
          ))}
          {chips.length > 4 && <span className="shrink-0 text-fg-3">+{chips.length - 4}</span>}
        </div>
      )}
      <div
        className={cn(
          "glass-composer flex h-11 items-center gap-1 rounded-full pr-1.5 pl-2",
          disabled && "opacity-70",
        )}
      >
        <IconButton
          size={28}
          icon={<IconAt size={14} />}
          label="Katman seç (@)"
          onClick={() => {
            const at = text.length;
            setText(`${text}@`);
            setMention({ query: "", start: at });
            input.current?.focus();
          }}
        />
        {busy ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-body text-fg-2">
            <Spinner size={13} />
            <span className="truncate">{busy.label}</span>
          </span>
        ) : (
          <input
            ref={input}
            aria-label="AI'dan değişiklik iste"
            placeholder={disabled ?? "Neyi değiştireyim? @ ile katman seç"}
            disabled={!!disabled}
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              const caret = e.target.selectionStart ?? v.length;
              const before = v.slice(0, caret);
              const m = /@([^\s@]*)$/.exec(before);
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
                if (mention) setMention(null);
                else input.current?.blur();
                e.stopPropagation();
                return;
              }
              if (e.key === "Backspace" && text === "" && picked?.length) {
                setPicked(picked.slice(0, -1));
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            className="min-w-0 flex-1 bg-transparent px-1 text-body text-fg outline-none placeholder:text-fg-3"
          />
        )}
        {busy?.cancel ? (
          <IconButton
            size={32}
            icon={<IconClose size={14} />}
            label="AI düzenlemesini durdur"
            onClick={busy.cancel}
          />
        ) : (
          <button
            type="button"
            aria-label="Gönder"
            disabled={!text.trim() || !!disabled || !!busy}
            onClick={() => void send()}
            className="flex size-8 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity disabled:bg-control disabled:text-fg-3"
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
                "flex h-8 items-center gap-2 rounded-[8px] px-2 text-left text-body",
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

/** The scope line an AI revision gets in front of the request. */
export function scopedInstruction(
  text: string,
  scope: readonly string[],
  describe: (key: string) => { slide: number; id: string; label: string } | null,
): string {
  if (scope.length === 0) return text;
  const parts = scope
    .map(describe)
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map((d) => `Kare ${d.slide + 1} › ${d.id} (${d.label})`);
  if (parts.length === 0) return text;
  return `Kapsam: ${parts.join(", ")}. Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\n${text}`;
}
