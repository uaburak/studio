// The composer (Wecra "Composer", Liquid Glass capsule, 44 pt): + attach, auto-growing text,
// mic, send / stop. Attached images show as chips with their @alias; typing `@` suggests the
// conversation's images. ↩ sends, ⇧↩ new line, ⌘↩ queues while a reply runs.

import { autoUpdate, FloatingPortal, flip, offset, shift, useFloating } from "@floating-ui/react";
import type { ConversationAlias } from "@studio/contract";
import { aliasBaseFor } from "@studio/contract";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { assetUrl, describeError, useApi } from "../../lib/api.ts";
import {
  type AssetDragPayload,
  attachDecision,
  hasAssetDrag,
  onComposerAttach,
  readAssetDrag,
} from "../../lib/asset-drag.ts";
import {
  allocateAlias,
  canSend,
  type Draft,
  insertMention,
  type MentionCandidate,
  makeMessage,
  mentionQuery,
  mentionSuggestions,
  sendButtonMode,
} from "../../lib/composer.ts";
import type { OutgoingMessage } from "../../lib/transcript.ts";
import { newClientMessageId } from "../../state/conversation.ts";
import { cn, IconButton, Spinner } from "../ui/controls.tsx";
import { IconArrowUp, IconClose, IconMic, IconPlus, IconWarning } from "../ui/icons.tsx";

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
}

export interface ComposerProps {
  placeholder: string;
  workingPlaceholder?: string;
  /** A reply runs (send queues; the empty send button stops it). */
  working: boolean;
  disabled?: boolean;
  /** Brand of the uploads; null: attaching is not possible. */
  brandId: string | null;
  attachDisabledReason?: string | null;
  aliases?: ConversationAlias[];
  onSend(message: OutgoingMessage, options: { queue: boolean }): Promise<boolean>;
  onStop?(): void;
  /** Starting text (gallery states). */
  initialText?: string;
  /** Show the focused look without focus (gallery). */
  forceFocus?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder,
    workingPlaceholder,
    working,
    disabled,
    brandId,
    attachDisabledReason,
    aliases = [],
    onSend,
    onStop,
    initialText = "",
    forceFocus = false,
  },
  ref,
) {
  const api = useApi();
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const draftsRef = useRef<Draft[]>([]);
  draftsRef.current = drafts;
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedQueryAt, setDismissedQueryAt] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setText: (value: string) => {
      setText(value);
      requestAnimationFrame(() => {
        const el = textarea.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(value.length, value.length);
      });
    },
  }));

  // Auto-grow up to ~8 lines.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // Revoke object URLs of removed drafts.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(drafts.map((d) => d.previewUrl));
    for (const url of previews.current) {
      // Studio assets attached as they are preview from their own URL (nothing to revoke).
      if (!current.has(url) && url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    previews.current = current;
  }, [drafts]);

  const canAttach = brandId !== null && !attachDisabledReason;

  const upload = useCallback(
    (files: File[]) => {
      if (!canAttach || !brandId) {
        setError(attachDisabledReason ?? "Görsel eklemek için önce bir marka seç.");
        return;
      }
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      const used = new Set<string>([
        ...aliases.flatMap((a) => [a.alias, ...a.previousAliases]),
        ...draftsRef.current.map((d) => d.alias),
      ]);
      const added: Draft[] = images.map((file) => {
        const alias = allocateAlias(aliasBaseFor(file.type), used);
        used.add(alias);
        return {
          id: newClientMessageId(),
          alias,
          previewUrl: URL.createObjectURL(file),
          filename: file.name,
          state: { kind: "uploading" },
        };
      });
      draftsRef.current = [...draftsRef.current, ...added];
      setDrafts((current) => [...current, ...added]);
      setError(null);
      for (const [i, draft] of added.entries()) {
        const file = images[i] as File;
        void api.assets
          .upload({ file, brandId, kind: "image", source: "upload" })
          .then((asset) =>
            setDrafts((list) =>
              list.map((d) =>
                d.id === draft.id ? { ...d, state: { kind: "uploaded", assetId: asset.id } } : d,
              ),
            ),
          )
          .catch((e) =>
            setDrafts((list) =>
              list.map((d) =>
                d.id === draft.id
                  ? { ...d, state: { kind: "failed", error: describeError(e) } }
                  : d,
              ),
            ),
          );
      }
    },
    [api, aliases, attachDisabledReason, brandId, canAttach],
  );

  // Studio assets (dragged from Medya, or "Sohbete ekle"): an asset of this brand is attached
  // as it is; one of another brand is copied into this brand (the API only takes its own).
  const attachAssets = useCallback(
    (payloads: AssetDragPayload[]) => {
      const used = new Set<string>([
        ...aliases.flatMap((a) => [a.alias, ...a.previousAliases]),
        ...draftsRef.current.map((d) => d.alias),
      ]);
      const added: Draft[] = [];
      for (const payload of payloads) {
        const decision = attachDecision(payload, canAttach ? brandId : null);
        if (decision === "refuse") {
          setError(
            canAttach
              ? "Yalnızca görseller eklenebilir."
              : (attachDisabledReason ?? "Görsel eklemek için önce bir marka seç."),
          );
          continue;
        }
        if (decision === "copy") {
          void fetch(assetUrl(payload.assetId))
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.blob();
            })
            .then((blob) =>
              upload([
                new File([blob], payload.filename ?? "gorsel", {
                  type: blob.type || payload.mimeType,
                }),
              ]),
            )
            .catch((e) => setError(`Görsel kopyalanamadı: ${describeError(e)}`));
          continue;
        }
        if (
          draftsRef.current.some(
            (d) => d.state.kind === "uploaded" && d.state.assetId === payload.assetId,
          )
        ) {
          continue;
        }
        const alias = allocateAlias(aliasBaseFor(payload.mimeType), used);
        used.add(alias);
        added.push({
          id: newClientMessageId(),
          alias,
          previewUrl: assetUrl(payload.assetId),
          filename: payload.filename ?? alias,
          state: { kind: "uploaded", assetId: payload.assetId },
        });
      }
      if (added.length === 0) return;
      draftsRef.current = [...draftsRef.current, ...added];
      setDrafts((current) => [...current, ...added]);
      setError(null);
      textarea.current?.focus();
    },
    [aliases, attachDisabledReason, brandId, canAttach, upload],
  );
  useEffect(() => onComposerAttach(attachAssets), [attachAssets]);

  // @mentions
  const candidates = useMemo<MentionCandidate[]>(
    () => [
      ...drafts.map((d) => ({
        alias: d.alias,
        assetId: d.state.kind === "uploaded" ? d.state.assetId : null,
        previewUrl: d.previewUrl,
        isDraft: true,
      })),
      ...aliases.map((a) => ({
        alias: a.alias,
        assetId: a.assetId,
        previewUrl: null,
        isDraft: false,
      })),
    ],
    [drafts, aliases],
  );
  const query = focused ? mentionQuery(text, caret) : null;
  const suggestions =
    query && query.start !== dismissedQueryAt
      ? mentionSuggestions(candidates, query.query).slice(0, 8)
      : [];
  useEffect(() => setSuggestionIndex(0), [query?.query, query?.start]);

  const pick = (alias: string) => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, alias);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(next.caret, next.caret));
  };

  const hasContent = canSend(text, drafts);
  const mode = sendButtonMode(hasContent, working);

  const submit = async (queue: boolean) => {
    if (!canSend(text, drafts) || disabled) return;
    const message = makeMessage(text, drafts, newClientMessageId());
    const savedText = text;
    const savedDrafts = drafts;
    setText("");
    setDrafts([]);
    setError(null);
    const ok = await onSend(message, { queue });
    if (!ok) {
      // Keep what was written.
      setText((t) => (t ? t : savedText));
      setDrafts((d) => (d.length ? d : savedDrafts));
    }
  };

  const { refs, floatingStyles } = useFloating({
    open: suggestions.length > 0,
    placement: "top-start",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const setShell = useCallback(
    (el: HTMLDivElement | null) => {
      shell.current = el;
      refs.setReference(el);
    },
    [refs],
  );

  return (
    <div className="relative">
      {error && (
        <div className="mb-2 flex items-center gap-1.5 px-3 text-footnote text-danger" role="alert">
          <IconWarning size={13} />
          {error}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for images */}
      <div
        ref={setShell}
        data-focused={focused || forceFocus || undefined}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files") || hasAssetDrag(event.dataTransfer)) {
            event.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const assets = readAssetDrag(event.dataTransfer);
          if (assets.length > 0) attachAssets(assets);
          else upload([...event.dataTransfer.files]);
        }}
        className={cn(
          "glass-composer flex flex-col rounded-[22px] transition-shadow duration-200",
          "data-[focused]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--focus-ring)_70%,transparent),var(--glass-composer-shadow)]",
          dragOver &&
            "shadow-[inset_0_0_0_1.5px_var(--accent-default),var(--glass-composer-shadow)]",
        )}
      >
        {drafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {drafts.map((draft) => (
              <AttachmentChip
                key={draft.id}
                draft={draft}
                onRemove={() => setDrafts((list) => list.filter((d) => d.id !== draft.id))}
              />
            ))}
          </div>
        )}
        <div className="flex min-h-11 items-end gap-0.5 p-1.5">
          <IconButton
            icon={<IconPlus size={16} strokeWidth={1.5} />}
            label={
              canAttach
                ? "Görsel ekle"
                : (attachDisabledReason ?? "Görsel eklemek için önce bir marka seç")
            }
            size={32}
            disabled={!canAttach || disabled}
            onClick={() => fileInput.current?.click()}
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              upload([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <textarea
            ref={textarea}
            rows={1}
            value={text}
            disabled={disabled}
            aria-label="Mesaj"
            placeholder={working && workingPlaceholder ? workingPlaceholder : placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissedQueryAt(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length > 0) {
                event.preventDefault();
                upload(files);
              }
            }}
            onKeyDown={(event) => {
              if (suggestions.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSuggestionIndex((i) => (i + delta + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const s = suggestions[suggestionIndex];
                  if (s) pick(s.alias);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedQueryAt(query?.start ?? null);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit(event.metaKey);
              }
            }}
            className="selectable my-[5px] max-h-[200px] min-h-[22px] flex-1 resize-none bg-transparent px-1.5 text-prose leading-[22px] text-fg outline-none placeholder:text-fg-3 focus-visible:shadow-none"
          />
          <IconButton
            icon={<IconMic size={16} strokeWidth={1.5} />}
            label="Sesle yaz (bir sonraki sürümde)"
            size={32}
            disabled={disabled}
            onClick={() => textarea.current?.focus()}
          />
          <SendButton
            mode={mode}
            disabled={disabled}
            onSend={() => void submit(working)}
            onStop={() => onStop?.()}
          />
        </div>
      </div>
      {suggestions.length > 0 && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            role="listbox"
            aria-label="Görseller"
            className="glass z-[90] w-[260px] animate-pop-in rounded-[12px] p-1"
          >
            {suggestions.map((s, i) => (
              <div
                key={s.alias}
                role="option"
                tabIndex={-1}
                aria-selected={i === suggestionIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(s.alias);
                }}
                onMouseEnter={() => setSuggestionIndex(i)}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-[8px] px-2",
                  i === suggestionIndex && "bg-control",
                )}
              >
                <span className="size-6 shrink-0 overflow-hidden rounded-[6px] bg-control">
                  {(s.previewUrl ?? (s.assetId ? assetUrl(s.assetId) : null)) && (
                    <img
                      src={s.previewUrl ?? assetUrl(s.assetId as string)}
                      alt=""
                      className="size-full object-cover"
                    />
                  )}
                </span>
                <span className="text-body text-fg">@{s.alias}</span>
                {s.isDraft && <span className="ml-auto text-caption text-fg-3">yeni</span>}
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
});

function SendButton({
  mode,
  disabled,
  onSend,
  onStop,
}: {
  mode: "send" | "stop" | "idle";
  disabled?: boolean | undefined;
  onSend(): void;
  onStop(): void;
}) {
  if (mode === "stop") {
    return (
      <button
        type="button"
        aria-label="Durdur"
        title="Durdur"
        onClick={onStop}
        className="no-drag flex size-8 shrink-0 items-center justify-center rounded-full bg-control-hover text-fg transition-colors hover:bg-control-pressed"
      >
        <span className="size-2.5 rounded-[2px] bg-current" />
      </button>
    );
  }
  const active = mode === "send" && !disabled;
  return (
    <button
      type="button"
      aria-label="Gönder"
      title="Gönder (↩)"
      disabled={!active}
      onClick={onSend}
      className={cn(
        "no-drag flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150",
        active
          ? "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed"
          : "bg-control text-fg-3",
      )}
    >
      <IconArrowUp size={16} strokeWidth={2} />
    </button>
  );
}

function AttachmentChip({ draft, onRemove }: { draft: Draft; onRemove(): void }) {
  const failed = draft.state.kind === "failed";
  return (
    <div
      title={failed ? (draft.state as { error: string }).error : draft.filename}
      className={cn(
        "flex h-8 items-center gap-2 rounded-full bg-control pr-1 pl-1 text-body",
        failed && "shadow-[inset_0_0_0_1px_var(--status-danger)]",
      )}
    >
      <span className="relative size-6 shrink-0 overflow-hidden rounded-full">
        <img src={draft.previewUrl} alt="" className="size-full object-cover" />
        {draft.state.kind === "uploading" && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
            <Spinner size={12} />
          </span>
        )}
      </span>
      <span className={failed ? "text-danger" : "text-fg"}>@{draft.alias}</span>
      <button
        type="button"
        aria-label={`@${draft.alias} kaldır`}
        onClick={onRemove}
        className="flex size-6 items-center justify-center rounded-full text-fg-2 hover:bg-control-hover hover:text-fg"
      >
        <IconClose size={12} strokeWidth={1.75} />
      </button>
    </div>
  );
}
