// The one floating object at the bottom of the canvas (Wecra's bottom toolbar: tools, a
// full-height line, the mode switch at the right). Its mode switch is Sohbet / Düzenle:
// Düzenle shows Wecra's own tools (its bottom toolbar's tool set: Move ▾, Region ▾, Shape ▾,
// Creation ▾, Text ▾), Sohbet turns the same object into the post's message box — the capsule
// morphs (width, height and content, `motion` layout animation) and back.
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MentionOptionBody } from "../../../components/chat/composer.tsx";
import { cn, IconButton } from "../../../components/ui/controls.tsx";
import { IconChat, IconClose, IconPencil } from "../../../components/ui/icons.tsx";
import { Popover } from "../../../components/ui/popover.tsx";
import { insertMention, type MentionCandidate, mentionSuggestions } from "../../../lib/composer.ts";
import type { ChatLayers } from "../wecra/scope.ts";
import type { WorkspaceMode } from "../workspace-store.ts";
import { IconArrowUp, IconAt } from "./glyphs.tsx";

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

// --- Sohbet: the message box --------------------------------------------------------------------

/** A row of the dock's `@` list: a canvas layer (scope) or a name written into the text. */
export type DockMentionOption =
  | { type: "layer"; key: string; label: string; detail?: string | undefined }
  | { type: "name"; candidate: MentionCandidate };

/** Names `@` offers after the layers (as many as the main composer shows). */
const MAX_NAMES = 10;

/**
 * The dock's `@` list for `query`: the canvas's layers (they become the request's scope), then
 * the chat's files and the brand's products and posts (written as `@name`, like the composer).
 */
export function dockMentionOptions(
  layers: readonly { key: string; label: string; detail?: string | undefined }[],
  names: readonly MentionCandidate[],
  query: string,
): DockMentionOption[] {
  const named = /^[\p{L}\p{N}-]*$/u.test(query)
    ? mentionSuggestions([...names], query.toLocaleLowerCase("tr")).slice(0, MAX_NAMES)
    : [];
  return [
    ...layers.map((l) => ({ type: "layer" as const, ...l })),
    ...named.map((candidate) => ({ type: "name" as const, candidate })),
  ];
}

export interface ChatInputHandle {
  /** Focus the box; `prefill` replaces the text, `scope` replaces the picked layers. */
  focus(prefill?: string, scope?: readonly string[]): void;
}

export const ChatInput = forwardRef<
  ChatInputHandle,
  {
    /** The canvas's layers the message may be about (`@`, the selection). */
    layers: ChatLayers;
    working: boolean;
    disabled: string | null;
    placeholder?: string;
    /** The chat's files and the brand's products and posts `@` offers after the layers. */
    mentions?: readonly MentionCandidate[];
    onSend(text: string, scope: readonly string[]): Promise<boolean>;
    onStop(): void;
  }
>(function ChatInput(
  { layers, working, disabled, placeholder, mentions = NO_MENTIONS, onSend, onStop },
  ref,
) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const scope = picked ?? layers.selection;

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

  const options = useMemo(
    () =>
      mention ? dockMentionOptions(layers.search(mention.query), mentions, mention.query) : [],
    [mention, layers, mentions],
  );
  const hasLayers = options.some((o) => o.type === "layer");
  const hasNames = options.some((o) => o.type === "name");
  const list = useRef<HTMLDivElement | null>(null);
  // Keys move through a list taller than the popover: the chosen row stays in view.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const pick = (option: DockMentionOption) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    if (option.type === "layer") {
      setPicked([...new Set([...(picked ?? []), option.key])]);
      setText(text.slice(0, mention.start) + text.slice(end));
      setMention(null);
      input.current?.focus();
      return;
    }
    // A file, product or post: written into the text (`@name `), the server resolves it.
    const next = insertMention(text, mention.start, end, option.candidate.alias);
    setText(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
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

  const chips = scope.map((key) => ({ key, label: layers.label(key) }));
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
                  picked ? setPicked(picked.filter((k) => k !== c.key)) : layers.deselect(c.key)
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
          label={mentions.length > 0 ? "Katman, ürün ya da post seç (@)" : "Katman seç (@)"}
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
            (working
              ? "↩ sıraya al · yanıt sürüyor"
              : mentions.length > 0
                ? "Bu post için ne yapayım? @ ile katman, ürün ya da post seç"
                : "Bu post için ne yapayım? @ ile katman seç")
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
                if (o) pick(o);
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
        label={hasNames ? "Katmanlar, görseller, ürünler ve postlar" : "Katmanlar"}
      >
        <div
          ref={list}
          role="listbox"
          aria-label={hasNames ? "Katman, görsel, ürün ya da post seç" : "Katman seç"}
          className={cn(
            "flex max-h-[340px] flex-col overflow-y-auto p-1",
            hasNames ? "w-[320px]" : "w-[280px]",
          )}
        >
          {options.map((o, i) => {
            const firstName = o.type === "name" && options[i - 1]?.type !== "name";
            return o.type === "layer" ? (
              <button
                key={`layer:${o.key}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-full px-2.5 text-left text-body",
                  i === active ? "bg-control" : "hover:bg-control",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-fg">@{o.label}</span>
                <span className="shrink-0 text-footnote text-fg-3">{o.detail}</span>
              </button>
            ) : (
              <div key={`${o.candidate.kind ?? "file"}:${o.candidate.alias}`} className="contents">
                {firstName && hasLayers && (
                  <div
                    role="presentation"
                    className="mx-2 mt-1 mb-0.5 border-t border-hairline pt-1.5 text-caption text-fg-3"
                  >
                    Görseller, ürünler ve postlar
                  </div>
                )}
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex h-9 shrink-0 items-center gap-2.5 rounded-[8px] px-2",
                    i === active && "bg-control",
                  )}
                >
                  <MentionOptionBody candidate={o.candidate} />
                </div>
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
});

const NO_MENTIONS: readonly MentionCandidate[] = [];
